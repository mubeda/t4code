import { EnvironmentId, ThreadId, type VcsRef, type VcsStatusResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type EffectCallback = () => void | (() => void);

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let stateSlots = new Map<number, unknown>();
  let refSlots = new Map<number, { current: unknown }>();
  let cacheSlots = new Map<number, unknown[]>();
  let optimisticSlots = new Map<number, unknown>();

  return {
    effects: [] as EffectCallback[],
    optimisticCalls: [] as unknown[],
    transitions: [] as Array<Promise<unknown>>,
    isTransitionPending: false,
    beginRender() {
      cursor = 0;
      this.effects = [];
    },
    reset() {
      cursor = 0;
      stateSlots = new Map();
      refSlots = new Map();
      cacheSlots = new Map();
      optimisticSlots = new Map();
      this.effects = [];
      this.optimisticCalls = [];
      this.transitions = [];
      this.isTransitionPending = false;
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
    useOptimistic<T, A>(
      passthrough: T,
      reducer: (state: T, action: A) => T,
    ): [T, (action: A) => void] {
      const index = cursor;
      cursor += 1;
      const value = optimisticSlots.has(index) ? (optimisticSlots.get(index) as T) : passthrough;
      const setOptimistic = (action: A) => {
        const current = optimisticSlots.has(index)
          ? (optimisticSlots.get(index) as T)
          : passthrough;
        optimisticSlots.set(index, reducer(current, action));
        this.optimisticCalls.push(action);
      };
      return [value, setOptimistic];
    },
    useTransition(): [boolean, (callback: () => Promise<void> | void) => void] {
      cursor += 1;
      const startTransition = (callback: () => Promise<void> | void) => {
        this.transitions.push(Promise.resolve(callback()));
      };
      return [this.isTransitionPending, startTransition];
    },
  };
});

const testState = vi.hoisted(() => ({
  serverThread: null as Record<string, unknown> | null,
  project: null as Record<string, unknown> | null,
  draftSession: null as Record<string, unknown> | null,
  draftThreadByRef: null as Record<string, unknown> | null,
  setDraftThreadContext: vi.fn(),
  statusQuery: {
    data: null as unknown,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  statusAtoms: [] as unknown[],
  branchState: {
    refs: [] as unknown[],
    data: null as { nextCursor: number | null; totalCount: number } | null,
    isPending: false,
    refresh: vi.fn(),
    loadNext: vi.fn(),
  },
  commands: {
    "cmd:stopSession": vi.fn(),
    "cmd:updateMetadata": vi.fn(),
    "cmd:switchRef": vi.fn(),
    "cmd:createRef": vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>,
  openPrLink: vi.fn(),
  toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
  scrollElement: null as unknown,
  listHandle: {
    getScrollableNode: (): unknown => testState.scrollElement,
    scrollIndexIntoView: vi.fn(),
    scrollToOffset: vi.fn(),
  },
}));

interface CapturedComboboxProps {
  items: string[];
  filteredItems: string[];
  open: boolean;
  value: string | null;
  onOpenChange: (open: boolean) => void;
  onItemHighlighted: (value: unknown, eventDetails: { reason: string; index: number }) => void;
}

interface CapturedItemProps {
  value: string;
  index: number;
  onClick: () => void;
  children?: unknown;
}

interface CapturedInputProps {
  value: string;
  onChange: (event: { target: { value: string } }) => void;
}

interface CapturedLegendProps {
  data: string[];
  keyExtractor: (item: string) => string;
  getItemType: (item: string) => string;
  renderItem: (args: { item: string; index: number }) => unknown;
  onEndReached: () => void;
  onLayout: () => void;
  onScroll: () => void;
  className: string;
}

interface CapturedTriggerProps {
  disabled?: boolean;
  children?: unknown;
}

interface CapturedTooltipTriggerProps {
  render?: ReactElement<Record<string, unknown>>;
  children?: unknown;
}

interface CapturedSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const captured = vi.hoisted(() => ({
  combobox: [] as CapturedComboboxProps[],
  items: [] as CapturedItemProps[],
  input: [] as CapturedInputProps[],
  legend: [] as CapturedLegendProps[],
  trigger: [] as CapturedTriggerProps[],
  tooltipTriggers: [] as CapturedTooltipTriggerProps[],
  switches: [] as CapturedSwitchProps[],
  clear() {
    this.combobox = [];
    this.items = [];
    this.input = [];
    this.legend = [];
    this.trigger = [];
    this.tooltipTriggers = [];
    this.switches = [];
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
    useEffect: hooks.useEffect.bind(hooks),
    useLayoutEffect: hooks.useLayoutEffect.bind(hooks),
    useDeferredValue: hooks.useDeferredValue,
    useOptimistic: hooks.useOptimistic.bind(hooks),
    useTransition: hooks.useTransition.bind(hooks),
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: CapturedLegendProps & { ref?: { current: unknown } }) => {
    captured.legend.push(props);
    if (props.ref) {
      props.ref.current = testState.listHandle;
    }
    return (
      <div data-testid="legend-list" className={props.className}>
        {props.data.map((item, index) => (
          <div key={props.keyExtractor(item)} data-item-type={props.getItemType(item)}>
            {props.renderItem({ item, index }) as never}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: <T,>(selector: (store: Record<string, unknown>) => T): T =>
    selector({
      getDraftSession: () => testState.draftSession,
      getDraftThreadByRef: () => testState.draftThreadByRef,
      setDraftThreadContext: testState.setDraftThreadContext,
    }),
}));

vi.mock("../lib/openPullRequestLink", () => ({
  useOpenPrLink: () => testState.openPrLink,
}));

vi.mock("../state/queries", () => ({
  usePaginatedBranches: () => testState.branchState,
}));

vi.mock("../state/entities", () => ({
  useProject: () => testState.project,
  useThread: () => testState.serverThread,
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    testState.statusAtoms.push(atom);
    return testState.statusQuery;
  },
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    stopSession: "cmd:stopSession",
    updateMetadata: "cmd:updateMetadata",
  },
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    switchRef: "cmd:switchRef",
    createRef: "cmd:createRef",
    status: (args: unknown) => ({ kind: "status-atom", args }),
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => testState.commands[String(command)],
}));

vi.mock("./ThreadStatusIndicators", () => ({
  resolveThreadPr: (branch: string | null, status: VcsStatusResult | null) =>
    branch !== null && status !== null && status.refName === branch ? (status.pr ?? null) : null,
  prStatusIndicator: (pr: { url: string } | null) =>
    pr ? { label: "pr", colorClass: "pr-color", tooltip: "", url: pr.url } : null,
  ChangeRequestStatusIcon: () => <span data-testid="pr-icon" />,
}));

vi.mock("./ui/toast", () => ({
  toastManager: testState.toast,
  stackedThreadToast: (toast: Record<string, unknown>) => ({ ...toast, stacked: true }),
}));

vi.mock("./ui/combobox", () => ({
  Combobox: (props: CapturedComboboxProps & { children?: unknown }) => {
    captured.combobox.push(props);
    return <div data-testid="combobox">{props.children as never}</div>;
  },
  ComboboxTrigger: (props: CapturedTriggerProps) => {
    captured.trigger.push(props);
    return (
      <div data-testid="trigger" data-disabled={props.disabled ? "true" : undefined}>
        {props.children as never}
      </div>
    );
  },
  ComboboxPopup: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  ComboboxInput: (props: CapturedInputProps) => {
    captured.input.push(props);
    return <div data-testid="combobox-input" data-value={props.value} />;
  },
  ComboboxItem: (props: CapturedItemProps) => {
    captured.items.push(props);
    return (
      <div data-testid="item" data-value={props.value}>
        {props.children as never}
      </div>
    );
  },
  ComboboxEmpty: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  ComboboxStatus: (props: { children?: unknown }) => (
    <div data-testid="status">{props.children as never}</div>
  ),
  ComboboxListVirtualized: (props: { children?: unknown }) => <div>{props.children as never}</div>,
}));

vi.mock("./ui/switch", () => ({
  Switch: (props: CapturedSwitchProps) => {
    captured.switches.push(props);
    return <span data-testid="switch" data-checked={props.checked ? "true" : "false"} />;
  },
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: (props: { children?: unknown }) => <>{props.children as never}</>,
  TooltipTrigger: (props: CapturedTooltipTriggerProps) => {
    captured.tooltipTriggers.push(props);
    return (
      <div data-testid="tooltip-trigger">
        {props.render ?? null}
        {(props.children as never) ?? null}
      </div>
    );
  },
  TooltipPopup: (props: { children?: unknown }) => (
    <div data-testid="tooltip-popup">{props.children as never}</div>
  ),
}));

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

class StubHTMLElement {
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
}

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const THREAD_ID = ThreadId.make("thread-1");

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function ref(overrides: Partial<VcsRef> & { name: string }): VcsRef {
  return {
    current: false,
    isDefault: false,
    worktreePath: null,
    ...overrides,
  };
}

const REFS: VcsRef[] = [
  ref({ name: "feature/test", current: true }),
  ref({ name: "main", isDefault: true }),
  ref({ name: "wt-branch", worktreePath: "C:/repo-wt" }),
  ref({ name: "origin/remote-only", isRemote: true }),
];

type SelectorProps = Parameters<typeof BranchToolbarBranchSelector>[0];

function buildProps(overrides: Partial<SelectorProps> = {}): SelectorProps {
  return {
    environmentId: ENVIRONMENT_ID,
    threadId: THREAD_ID,
    envLocked: false,
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    ...overrides,
  };
}

let lastProps: SelectorProps = buildProps();

function render(props: SelectorProps): string {
  lastProps = props;
  hooks.beginRender();
  captured.clear();
  return renderToStaticMarkup(<BranchToolbarBranchSelector {...props} />);
}

function rerender(): string {
  return render(lastProps);
}

function openMenu(): void {
  captured.combobox[0]?.onOpenChange(true);
  rerender();
}

function itemByValue(value: string): CapturedItemProps | undefined {
  return captured.items.find((item) => item.value === value);
}

async function settleTransitions(): Promise<void> {
  while (hooks.transitions.length > 0) {
    const pending = hooks.transitions.splice(0, hooks.transitions.length);
    await Promise.all(pending);
  }
}

function useServerThread(overrides: Record<string, unknown> = {}): void {
  testState.serverThread = {
    id: THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: "proj-1",
    branch: "feature/test",
    worktreePath: null,
    session: null,
    ...overrides,
  };
  testState.project = { id: "proj-1", workspaceRoot: "C:/repo" };
}

function useDraftThread(overrides: Record<string, unknown> = {}): void {
  testState.serverThread = null;
  testState.draftThreadByRef = {
    environmentId: ENVIRONMENT_ID,
    projectId: "proj-1",
    branch: null,
    worktreePath: null,
    envMode: "worktree",
    ...overrides,
  };
  testState.project = { id: "proj-1", workspaceRoot: "C:/repo" };
}

beforeAll(() => {
  vi.stubGlobal("HTMLElement", StubHTMLElement);
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  hooks.reset();
  captured.clear();
  testState.serverThread = null;
  testState.project = null;
  testState.draftSession = null;
  testState.draftThreadByRef = null;
  testState.setDraftThreadContext.mockReset();
  testState.statusQuery = { data: status(), error: null, isPending: false, refresh: vi.fn() };
  testState.statusAtoms = [];
  testState.branchState = {
    refs: [...REFS],
    data: { nextCursor: null, totalCount: REFS.length },
    isPending: false,
    refresh: vi.fn(),
    loadNext: vi.fn(),
  };
  testState.commands = {
    "cmd:stopSession": vi.fn().mockResolvedValue(AsyncResult.success(undefined)),
    "cmd:updateMetadata": vi.fn().mockResolvedValue(AsyncResult.success(undefined)),
    "cmd:switchRef": vi.fn().mockResolvedValue(AsyncResult.success({ refName: null })),
    "cmd:createRef": vi.fn().mockResolvedValue(AsyncResult.success({ refName: "created" })),
  };
  testState.openPrLink = vi.fn();
  testState.toast.add.mockReset();
  testState.toast.update.mockReset();
  testState.toast.close.mockReset();
  testState.scrollElement = null;
  testState.listHandle.scrollIndexIntoView.mockReset();
  testState.listHandle.scrollToOffset.mockReset();
});

describe("BranchToolbarBranchSelector", () => {
  it("renders the current branch with ref badges and a PR pill", () => {
    useServerThread();
    testState.statusQuery.data = status({
      pr: {
        number: 12,
        title: "Open PR",
        url: "https://example.com/pr/12",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    });

    const markup = render(buildProps());

    expect(markup).toContain("feature/test");
    expect(markup).toContain("#12");
    expect(markup).toContain("current");
    expect(markup).toContain("default");
    expect(markup).toContain("worktree");
    expect(markup).toContain("remote");
    expect(markup).toContain("Open pull request #12 (open) in browser");
    expect(markup).toContain("No refs found.");

    // The pill button opens the PR link.
    const pill = captured.tooltipTriggers[0]?.render;
    expect(pill?.type).toBe("button");
    if (!pill) {
      throw new Error("Expected pull request pill trigger");
    }
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (pill.props.onClick as (event: unknown) => void)(event);
    expect(testState.openPrLink).toHaveBeenCalledWith(event, "https://example.com/pr/12");
  });

  it("falls back to 'Select ref' when nothing resolves a branch", () => {
    testState.statusQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
    testState.branchState.refs = [];
    testState.branchState.data = null;
    const markup = render(buildProps());
    expect(markup).toContain("Select ref");
    // Without a project there is no cwd, so the status query gets no atom.
    expect(testState.statusAtoms[0]).toBeNull();
  });

  it("labels an unmaterialized worktree selection as 'From <branch>'", () => {
    useDraftThread({ branch: "main" });
    testState.statusQuery.data = status({ refName: null });
    const markup = render(buildProps());
    expect(markup).toContain("From main");
  });

  it("refreshes refs when the menu opens and clears the query when it closes", () => {
    useServerThread();
    render(buildProps());

    captured.combobox[0]?.onOpenChange(true);
    expect(testState.branchState.refresh).toHaveBeenCalledTimes(1);
    rerender();

    captured.input[0]?.onChange({ target: { value: "ma" } });
    rerender();
    expect(captured.input[0]?.value).toBe("ma");

    captured.combobox[0]?.onOpenChange(false);
    rerender();
    expect(captured.input[0]?.value).toBe("");
  });

  it("filters refs by the typed query and offers ref creation", () => {
    useServerThread();
    render(buildProps());
    openMenu();

    captured.input[0]?.onChange({ target: { value: "new-feature" } });
    rerender();

    expect(captured.combobox[0]?.filteredItems).toEqual(["__create_new_branch__:new-feature"]);
    const markup = rerender();
    expect(markup).toContain("Create new ref");
    expect(markup).toContain("new-feature");
  });

  it("hides the create item when the query matches an existing ref exactly", () => {
    useServerThread();
    render(buildProps());
    openMenu();

    captured.input[0]?.onChange({ target: { value: "main" } });
    rerender();

    expect(captured.combobox[0]?.filteredItems).toEqual(["main"]);
  });

  it("offers a checkout item for pull request references", () => {
    useServerThread();
    const onCheckoutPullRequestRequest = vi.fn();
    const onComposerFocusRequest = vi.fn();
    render(buildProps({ onCheckoutPullRequestRequest, onComposerFocusRequest }));
    openMenu();

    captured.input[0]?.onChange({ target: { value: "#123" } });
    const markup = rerender();

    expect(captured.combobox[0]?.filteredItems[0]).toBe("__checkout_pull_request__:123");
    expect(markup).toContain("Checkout pull request");

    itemByValue("__checkout_pull_request__:123")?.onClick();
    expect(onCheckoutPullRequestRequest).toHaveBeenCalledWith("123");
    expect(onComposerFocusRequest).toHaveBeenCalled();
    rerender();
    expect(captured.input[0]?.value).toBe("");
  });

  it("assigns the base branch without a checkout when picking a worktree base", () => {
    useDraftThread();
    testState.statusQuery.data = status({ refName: null });
    const onComposerFocusRequest = vi.fn();
    render(buildProps({ onComposerFocusRequest }));
    openMenu();

    itemByValue("main")?.onClick();

    expect(testState.setDraftThreadContext).toHaveBeenCalledWith(
      { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
      {
        branch: "main",
        worktreePath: null,
        envMode: "worktree",
        projectRef: { environmentId: ENVIRONMENT_ID, projectId: "proj-1" },
      },
    );
    expect(testState.commands["cmd:switchRef"]).not.toHaveBeenCalled();
    expect(onComposerFocusRequest).toHaveBeenCalled();
  });

  it("reuses an existing worktree and stops the running session", () => {
    const onActiveThreadBranchOverrideChange = vi.fn();
    useServerThread({ session: { id: "session-1" } });
    render(buildProps({ onActiveThreadBranchOverrideChange }));
    openMenu();

    itemByValue("wt-branch")?.onClick();

    expect(testState.commands["cmd:stopSession"]).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID },
    });
    expect(testState.commands["cmd:updateMetadata"]).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, branch: "wt-branch", worktreePath: "C:/repo-wt" },
    });
    expect(onActiveThreadBranchOverrideChange).toHaveBeenCalledWith("wt-branch");
    expect(testState.commands["cmd:switchRef"]).not.toHaveBeenCalled();
  });

  it("checks out a local branch and persists it on success", async () => {
    const onActiveThreadBranchOverrideChange = vi.fn();
    useServerThread();
    render(buildProps({ onActiveThreadBranchOverrideChange }));
    openMenu();

    itemByValue("main")?.onClick();
    await settleTransitions();

    expect(testState.commands["cmd:switchRef"]).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { cwd: "C:/repo", refName: "main" },
    });
    expect(hooks.optimisticCalls).toEqual(["main", "main"]);
    expect(testState.commands["cmd:updateMetadata"]).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, branch: "main", worktreePath: null },
    });
    expect(onActiveThreadBranchOverrideChange).toHaveBeenCalledWith("main");
    expect(testState.branchState.refresh).toHaveBeenCalled();
    expect(testState.statusQuery.refresh).toHaveBeenCalled();
    expect(testState.toast.add).not.toHaveBeenCalled();
  });

  it("derives the local name when checking out a remote ref", async () => {
    useServerThread();
    testState.commands["cmd:switchRef"] = vi
      .fn()
      .mockResolvedValue(AsyncResult.success({ refName: "remote-only" }));
    render(buildProps());
    openMenu();

    itemByValue("origin/remote-only")?.onClick();
    await settleTransitions();

    expect(hooks.optimisticCalls).toEqual(["remote-only", "remote-only"]);
    expect(testState.commands["cmd:updateMetadata"]).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, branch: "remote-only", worktreePath: null },
    });
  });

  it("reverts the optimistic branch and toasts when checkout fails", async () => {
    useServerThread();
    testState.commands["cmd:switchRef"] = vi
      .fn()
      .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("checkout exploded"))));
    render(buildProps());
    openMenu();

    itemByValue("main")?.onClick();
    await settleTransitions();

    expect(hooks.optimisticCalls).toEqual(["main", "feature/test"]);
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to switch ref.",
        description: "checkout exploded",
        stacked: true,
      }),
    );
    expect(testState.commands["cmd:updateMetadata"]).not.toHaveBeenCalled();
  });

  it("stays quiet when the checkout is interrupted", async () => {
    useServerThread();
    testState.commands["cmd:switchRef"] = vi
      .fn()
      .mockResolvedValue(AsyncResult.failure(Cause.interrupt(1)));
    render(buildProps());
    openMenu();

    itemByValue("main")?.onClick();
    await settleTransitions();

    expect(testState.toast.add).not.toHaveBeenCalled();
  });

  it("creates a new ref from the query and persists it", async () => {
    const onActiveThreadBranchOverrideChange = vi.fn();
    useServerThread();
    testState.commands["cmd:createRef"] = vi
      .fn()
      .mockResolvedValue(AsyncResult.success({ refName: "new-feature" }));
    render(buildProps({ onActiveThreadBranchOverrideChange }));
    openMenu();
    captured.input[0]?.onChange({ target: { value: "new-feature" } });
    rerender();

    itemByValue("__create_new_branch__:new-feature")?.onClick();
    await settleTransitions();

    expect(testState.commands["cmd:createRef"]).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { cwd: "C:/repo", refName: "new-feature", switchRef: true },
    });
    expect(hooks.optimisticCalls).toEqual(["new-feature", "new-feature"]);
    expect(onActiveThreadBranchOverrideChange).toHaveBeenCalledWith("new-feature");
  });

  it("toasts when ref creation fails", async () => {
    useServerThread();
    testState.commands["cmd:createRef"] = vi
      .fn()
      .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("create exploded"))));
    render(buildProps());
    openMenu();
    captured.input[0]?.onChange({ target: { value: "bad-ref" } });
    rerender();

    itemByValue("__create_new_branch__:bad-ref")?.onClick();
    await settleTransitions();

    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to create and switch ref.",
        description: "create exploded",
      }),
    );
  });

  it("ignores branch selection while an action is pending", () => {
    useServerThread();
    hooks.isTransitionPending = true;
    const markup = render(buildProps());
    openMenu();

    itemByValue("main")?.onClick();

    expect(testState.commands["cmd:switchRef"]).not.toHaveBeenCalled();
    expect(markup).toContain('data-disabled="true"');
  });

  it("reports paging progress in the status footer", () => {
    useServerThread();
    testState.branchState.isPending = true;
    testState.branchState.data = null;
    let markup = render(buildProps());
    expect(markup).toContain("Loading refs...");
    expect(markup).toContain('data-disabled="true"');

    testState.branchState.data = { nextCursor: 2, totalCount: 30 };
    markup = rerender();
    expect(markup).toContain("Loading more refs...");

    testState.branchState.isPending = false;
    markup = rerender();
    expect(markup).toContain(`Showing ${REFS.length} of 30 refs`);
  });

  it("renders the start-from-origin switch only when selecting a worktree base", () => {
    useDraftThread();
    testState.statusQuery.data = status({ refName: null });
    const onStartFromOriginChange = vi.fn();
    const markup = render(buildProps({ onStartFromOriginChange, startFromOrigin: false }));

    expect(markup).toContain("Start from origin");
    captured.switches[0]?.onCheckedChange(true);
    expect(onStartFromOriginChange).toHaveBeenCalledWith(true);

    useServerThread();
    const localMarkup = render(buildProps());
    expect(localMarkup).not.toContain("Start from origin");
  });

  it("adopts the current git branch for an empty worktree draft", () => {
    useDraftThread();
    render(buildProps());
    hooks.runEffects();

    expect(testState.setDraftThreadContext).toHaveBeenCalledWith(
      { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
      expect.objectContaining({ branch: "feature/test", worktreePath: null }),
    );
  });

  it("does not adopt a branch when the thread already has one", () => {
    useDraftThread({ branch: "already-set" });
    render(buildProps());
    hooks.runEffects();
    expect(testState.setDraftThreadContext).not.toHaveBeenCalled();
  });

  it("fetches the next page when scrolled near the bottom of the list", () => {
    useServerThread();
    testState.branchState.data = { nextCursor: 2, totalCount: 30 };
    const scrollElement = new StubHTMLElement();
    scrollElement.scrollHeight = 300;
    scrollElement.clientHeight = 100;
    scrollElement.scrollTop = 150;
    testState.scrollElement = scrollElement;

    render(buildProps());
    openMenu();
    hooks.runEffects();

    captured.legend[0]?.onLayout();
    expect(testState.branchState.loadNext).toHaveBeenCalled();

    // Far from the bottom: no fetch.
    testState.branchState.loadNext.mockClear();
    scrollElement.scrollTop = 0;
    captured.legend[0]?.onScroll();
    expect(testState.branchState.loadNext).not.toHaveBeenCalled();

    // The end-reached callback always fetches while more pages exist.
    captured.legend[0]?.onEndReached();
    expect(testState.branchState.loadNext).toHaveBeenCalledTimes(1);

    const masked = rerender();
    expect(masked).toContain("mask-b-from");
  });

  it("scrolls keyboard highlights into view while the menu is open", () => {
    useServerThread();
    render(buildProps());

    // Closed menu: highlight events are ignored.
    captured.combobox[0]?.onItemHighlighted("main", { reason: "keyboard", index: 1 });
    expect(testState.listHandle.scrollIndexIntoView).not.toHaveBeenCalled();

    openMenu();
    captured.combobox[0]?.onItemHighlighted("main", { reason: "keyboard", index: 1 });
    expect(testState.listHandle.scrollIndexIntoView).toHaveBeenCalledWith({
      index: 1,
      animated: false,
    });
    captured.combobox[0]?.onItemHighlighted("main", { reason: "pointer", index: 1 });
    expect(testState.listHandle.scrollIndexIntoView).toHaveBeenCalledTimes(1);

    hooks.runEffects();
    expect(testState.listHandle.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
  });
});
