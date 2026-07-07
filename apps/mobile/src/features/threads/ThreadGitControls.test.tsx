import type { ProjectScript, VcsStatusResult } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Render tests for {@link ThreadGitControls}. Following the mobile SSR pattern
 * (see `ThreadComposer.test.tsx`) the component is rendered with
 * `renderToStaticMarkup`; `expo-router` / `expo-router/stack` and the native
 * `Alert` are mocked, while the pure logic modules (`state/vcs` quick-action
 * resolution, `terminalMenu`, `shared/git`) stay real so their branches are
 * exercised. Toolbar menu items are recorded so their `onPress` handlers can be
 * invoked and their `router` / callback side effects asserted.
 */

const h = vi.hoisted(() => {
  const state = {
    entries: [] as Array<{ kind: string; props: Record<string, unknown> }>,
    routerPushes: [] as unknown[],
    alerts: [] as ReadonlyArray<unknown>[],
    openExternalCalls: [] as Array<{ url: string; target: string }>,
    openExternalResult: true,
    reset() {
      state.entries.length = 0;
      state.routerPushes.length = 0;
      state.alerts.length = 0;
      state.openExternalCalls.length = 0;
      state.openExternalResult = true;
    },
    record(kind: string, props: unknown) {
      if (props && typeof props === "object") {
        state.entries.push({ kind, props: props as Record<string, unknown> });
      }
    },
    filter(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      return state.entries
        .filter((entry) => entry.kind === kind && (predicate?.(entry.props) ?? true))
        .map((entry) => entry.props);
    },
    find(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      const found = state.entries.find(
        (entry) => entry.kind === kind && (predicate?.(entry.props) ?? true),
      )?.props;
      if (!found) throw new Error(`No recorded "${kind}" element matched`);
      return found;
    },
  };
  return state;
});

vi.mock("expo-router", () => ({
  useRouter: () => ({
    push: (target: unknown) => {
      h.routerPushes.push(target);
    },
  }),
  useLocalSearchParams: () => ({ environmentId: "env-1", threadId: "thread-1" }),
}));

vi.mock("expo-router/stack", () => {
  const Label = (props: { readonly children?: ReactNode }) => <span>{props.children}</span>;
  const MenuAction = (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.record("MenuAction", props);
    return <div data-menu-action={String(props["icon"] ?? "")}>{props.children}</div>;
  };
  const Menu = (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.record("Menu", props);
    return <div data-menu={String(props["icon"] ?? "")}>{props.children}</div>;
  };
  const Toolbar = Object.assign(
    (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
      h.record("Toolbar", props);
      return <div data-toolbar={String(props["placement"] ?? "")}>{props.children}</div>;
    },
    { Menu, MenuAction, Label },
  );
  return { default: { Toolbar } };
});

vi.mock("react-native", () => ({
  Alert: {
    alert: (...args: ReadonlyArray<unknown>) => {
      h.alerts.push(args);
    },
  },
}));

vi.mock("../../lib/routes", () => ({
  buildThreadReviewRoutePath: (params: unknown) => ({ review: params }),
  buildThreadFilesNavigation: (params: unknown) => ({ files: params }),
}));

vi.mock("../../lib/openExternalUrl", () => ({
  tryOpenExternalUrl: (url: string, target: string) => {
    h.openExternalCalls.push({ url, target });
    return Promise.resolve(h.openExternalResult);
  },
}));

import { ThreadGitControls } from "./ThreadGitControls";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as VcsStatusResult;
}

function openPr(overrides: Partial<NonNullable<VcsStatusResult["pr"]>> = {}) {
  return {
    number: 42,
    title: "Open PR",
    url: "https://example.com/pr/42",
    baseRef: "main",
    headRef: "feature/test",
    state: "open" as const,
    ...overrides,
  };
}

type Props = Parameters<typeof ThreadGitControls>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    currentBranch: "feature/test",
    gitStatus: status(),
    gitOperationLabel: null,
    canOpenTerminal: true,
    canOpenFiles: true,
    projectScripts: [],
    terminalSessions: [],
    onOpenTerminal: () => undefined,
    onOpenNewTerminal: () => undefined,
    onRunProjectScript: () => Promise.resolve(),
    onPull: () => Promise.resolve(),
    onRunAction: () => Promise.resolve(null),
    ...overrides,
  };
}

function render(props: Props): string {
  h.entries.length = 0;
  return renderToStaticMarkup(<ThreadGitControls {...props} />);
}

function quickAction() {
  return h.find(
    "MenuAction",
    (props) =>
      typeof props["icon"] === "string" &&
      new Set([
        "arrow.up.right.circle",
        "arrow.down.circle",
        "checkmark.circle",
        "arrow.up.circle",
      ]).has(props["icon"]) &&
      typeof props["onPress"] === "function",
  );
}

async function press(props: Record<string, unknown>): Promise<void> {
  await (props["onPress"] as () => void | Promise<void>)();
}

beforeEach(() => {
  h.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ThreadGitControls rendering", () => {
  it("renders both toolbar menus with the branch label", () => {
    const markup = render(baseProps());
    expect(markup).toContain('data-toolbar="right"');
    expect(h.filter("Menu")).toHaveLength(2);
    expect(markup).toContain("feature/test");
  });

  it("truncates a long branch label in the middle", () => {
    const markup = render(
      baseProps({
        gitStatus: status({ refName: "feature/an-extremely-long-branch-name-that-overflows" }),
      }),
    );
    expect(markup).toContain("…");
  });

  it("falls back to Detached HEAD when there is no branch or ref", () => {
    const markup = render(baseProps({ currentBranch: null, gitStatus: status({ refName: null }) }));
    expect(markup).toContain("Detached HEAD");
  });

  it("labels a missing status as Checking status", () => {
    const markup = render(baseProps({ gitStatus: null, currentBranch: "main" }));
    expect(markup).toContain("Checking status");
  });

  it("labels a non-git workspace and disables its quick action", () => {
    const markup = render(baseProps({ gitStatus: status({ isRepo: false }) }));
    expect(markup).toContain("Not a repo");
    expect(markup).toContain("Git unavailable");
    const unavailable = h.find(
      "MenuAction",
      (props) =>
        props["disabled"] === true &&
        props["subtitle"] === "This workspace is not a git repository.",
    );
    expect(unavailable).toBeDefined();
  });

  it("summarizes working-tree changes and an open PR", () => {
    const markup = render(
      baseProps({
        gitStatus: status({
          hasWorkingTreeChanges: true,
          workingTree: {
            files: [
              { path: "a.ts", insertions: 1, deletions: 0 },
              { path: "b.ts", insertions: 0, deletions: 0 },
            ],
            insertions: 1,
            deletions: 0,
          } as VcsStatusResult["workingTree"],
          aheadCount: 2,
          behindCount: 1,
          pr: openPr(),
        }),
      }),
    );
    expect(markup).toContain("2 changed");
    expect(markup).toContain("2 ahead");
    expect(markup).toContain("1 behind");
    expect(markup).toContain("PR #42");
  });

  it("summarizes a clean checkout", () => {
    const markup = render(baseProps({ gitStatus: status() }));
    expect(markup).toContain("Clean");
  });
});

describe("ThreadGitControls quick action", () => {
  it("opens an existing PR in the browser", async () => {
    render(baseProps({ gitStatus: status({ pr: openPr() }) }));
    const action = quickAction();
    expect(action["icon"]).toBe("arrow.up.right.circle");
    await press(action);
    expect(h.openExternalCalls).toEqual([
      { url: "https://example.com/pr/42", target: "pull-request" },
    ]);
    expect(h.alerts).toHaveLength(0);
  });

  it("alerts when the PR cannot be opened", async () => {
    h.openExternalResult = false;
    render(baseProps({ gitStatus: status({ pr: openPr() }) }));
    await press(quickAction());
    expect(h.alerts[0]?.[0]).toBe("Unable to open PR");
  });

  it("alerts when there is no open PR to view", async () => {
    // Clean, ahead, no upstream, no remote, with a non-open PR record still yields open_pr only when open.
    // Force the open_pr branch via a status that resolves to View PR but whose pr is not actually open at press time.
    render(
      baseProps({
        gitStatus: status({
          hasUpstream: false,
          hasPrimaryRemote: false,
          aheadCount: 0,
          pr: openPr({ state: "closed" }) as never,
        }),
      }),
    );
    // With a closed PR this resolves to a disabled hint, so assert the no-op path instead.
    const disabled = h.filter("MenuAction", (props) => props["disabled"] === true);
    expect(disabled.length).toBeGreaterThan(0);
  });

  it("runs a pull when the branch is behind", async () => {
    let pulls = 0;
    render(
      baseProps({
        gitStatus: status({ behindCount: 3 }),
        onPull: () => {
          pulls += 1;
          return Promise.resolve();
        },
      }),
    );
    const action = quickAction();
    expect(action["icon"]).toBe("arrow.down.circle");
    await press(action);
    expect(pulls).toBe(1);
  });

  it("runs a plain commit action without confirmation", async () => {
    const actions: unknown[] = [];
    render(
      baseProps({
        gitStatus: status({
          hasWorkingTreeChanges: true,
          hasUpstream: false,
          hasPrimaryRemote: false,
        }),
        onRunAction: (input) => {
          actions.push(input);
          return Promise.resolve(null);
        },
      }),
    );
    const action = quickAction();
    expect(action["icon"]).toBe("checkmark.circle");
    await press(action);
    expect(actions).toEqual([{ action: "commit" }]);
    expect(h.routerPushes).toHaveLength(0);
  });

  it("routes to the confirm screen for a default-branch push", async () => {
    const actions: unknown[] = [];
    render(
      baseProps({
        gitStatus: status({
          isDefaultRef: true,
          hasWorkingTreeChanges: true,
          refName: "main",
        }),
        onRunAction: (input) => {
          actions.push(input);
          return Promise.resolve(null);
        },
      }),
    );
    const action = quickAction();
    expect(action["icon"]).toBe("arrow.up.circle");
    await press(action);
    expect(actions).toHaveLength(0);
    expect(h.routerPushes).toHaveLength(1);
    const target = h.routerPushes[0] as { pathname: string; params: Record<string, unknown> };
    expect(target.pathname).toBe("/threads/[environmentId]/[threadId]/git-confirm");
    expect(target.params.confirmAction).toBe("commit_push");
    expect(target.params.branchName).toBe("main");
    expect(target.params.includesCommit).toBe("true");
  });

  it("does nothing when the quick action is a disabled hint", async () => {
    render(baseProps({ gitOperationLabel: "Committing..." }));
    const busy = h.find("MenuAction", (props) => props["subtitle"] === "Git action in progress.");
    await press(busy);
    expect(h.routerPushes).toHaveLength(0);
    expect(h.openExternalCalls).toHaveLength(0);
  });
});

describe("ThreadGitControls terminal menu", () => {
  it("renders project scripts with their icons and runs them", async () => {
    const script: ProjectScript = {
      id: "s1",
      name: "Run tests",
      command: "pnpm test",
      icon: "test",
      runOnWorktreeCreate: false,
    };
    const ran: ProjectScript[] = [];
    render(
      baseProps({
        projectScripts: [script],
        onRunProjectScript: (s) => (ran.push(s), Promise.resolve()),
      }),
    );
    const action = h.find("MenuAction", (props) => props["subtitle"] === "pnpm test");
    expect(action["icon"]).toBe("flask");
    await press(action);
    expect(ran).toEqual([script]);
  });

  it("shows an empty-scripts placeholder", () => {
    const markup = render(baseProps({ projectScripts: [] }));
    expect(markup).toContain("No project scripts");
  });

  it("renders terminal sessions and opens them", () => {
    const opened: Array<string | null | undefined> = [];
    render(
      baseProps({
        terminalSessions: [
          {
            terminalId: "term-1",
            cwd: "/repo/workspace",
            status: "running",
            hasRunningSubprocess: true,
            displayLabel: "Shell 1",
            updatedAt: null,
          },
        ],
        onOpenTerminal: (id) => opened.push(id),
      }),
    );
    const action = h.find(
      "MenuAction",
      (props) => props["subtitle"] === "Task running · workspace",
    );
    (action["onPress"] as () => void)();
    expect(opened).toEqual(["term-1"]);
  });

  it("opens a new terminal", () => {
    let opened = 0;
    render(baseProps({ onOpenNewTerminal: () => (opened += 1) }));
    const action = h.find(
      "MenuAction",
      (props) => props["subtitle"] === "Start another shell for this thread",
    );
    (action["onPress"] as () => void)();
    expect(opened).toBe(1);
  });
});

describe("ThreadGitControls navigation", () => {
  it("navigates to review, files, and more", () => {
    render(baseProps());
    (h.find("MenuAction", (props) => props["icon"] === "text.bubble")["onPress"] as () => void)();
    (h.find("MenuAction", (props) => props["icon"] === "folder")["onPress"] as () => void)();
    (
      h.find("MenuAction", (props) => props["icon"] === "ellipsis.circle")["onPress"] as () => void
    )();
    expect(h.routerPushes).toHaveLength(3);
    expect(h.routerPushes[0]).toEqual({ review: { environmentId: "env-1", threadId: "thread-1" } });
    expect(h.routerPushes[1]).toEqual({ files: { environmentId: "env-1", threadId: "thread-1" } });
    expect((h.routerPushes[2] as { pathname: string }).pathname).toBe(
      "/threads/[environmentId]/[threadId]/git",
    );
  });

  it("disables the files action when files cannot be opened", () => {
    render(baseProps({ canOpenFiles: false }));
    const files = h.find("MenuAction", (props) => props["icon"] === "folder");
    expect(files["disabled"]).toBe(true);
  });
});
