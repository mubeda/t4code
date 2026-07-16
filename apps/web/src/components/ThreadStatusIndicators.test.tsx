import type { SidebarThreadSummary } from "../types";
import { EnvironmentId, ProjectId, ThreadId } from "@t4code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  gitStatus: null as Record<string, unknown> | null,
  runningIds: [] as string[],
  environment: null as { label: string } | null,
  primaryEnvironmentId: null as string | null,
  project: null as { workspaceRoot: string } | null,
  statusPill: null as Record<string, unknown> | null,
  lastVisitedAt: null as string | null,
}));

vi.mock("../state/environments", () => ({
  useEnvironment: () => harness.environment,
  usePrimaryEnvironmentId: () => harness.primaryEnvironmentId,
}));
vi.mock("../state/entities", () => ({ useProject: () => harness.project }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: harness.gitStatus }),
}));
vi.mock("../state/terminalSessions", () => ({
  useThreadRunningTerminalIds: () => harness.runningIds,
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { status: (input: unknown) => input },
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ threadLastVisitedAtById: new Proxy({}, { get: () => harness.lastVisitedAt }) }),
}));
vi.mock("./Sidebar.logic", () => ({
  resolveThreadStatusPill: () => harness.statusPill,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render: React.ReactNode;
  }) => (
    <span>
      {render}
      {children}
    </span>
  ),
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadStatusLabel,
  ThreadWorktreeIndicator,
} from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("env-1");
const thread = {
  environmentId,
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  branch: "feature/test",
  worktreePath: "/repo/.worktrees/test",
  updatedAt: "2026-07-16T00:00:00.000Z",
} as SidebarThreadSummary;

beforeEach(() => {
  harness.gitStatus = null;
  harness.runningIds = [];
  harness.environment = null;
  harness.primaryEnvironmentId = null;
  harness.project = null;
  harness.statusPill = null;
  harness.lastVisitedAt = null;
});

describe("thread status indicators", () => {
  it("maps open, closed, merged, absent, and unknown change requests", () => {
    const base = {
      number: 42,
      title: "Ship it",
      url: "https://example.test/42",
      baseRef: "main",
      headRef: "feature/test",
    };
    const github = { kind: "github" as const, name: "GitHub", baseUrl: "https://github.com" };
    const gitlab = { kind: "gitlab" as const, name: "GitLab", baseUrl: "https://gitlab.com" };
    expect(prStatusIndicator(null, null)).toBeNull();
    expect(prStatusIndicator({ ...base, state: "open" }, github)).toMatchObject({
      label: "PR open",
      tooltip: "#42 PR open: Ship it",
    });
    expect(prStatusIndicator({ ...base, state: "closed" }, github)).toMatchObject({
      label: "PR closed",
    });
    expect(prStatusIndicator({ ...base, state: "merged" }, gitlab)).toMatchObject({
      label: "MR merged",
    });
    expect(prStatusIndicator({ ...base, state: "draft" } as never, null)).toBeNull();
    expect(renderToStaticMarkup(<ChangeRequestStatusIcon className="icon" />)).toContain("icon");
  });

  it("resolves a change request only for a matching branch", () => {
    const pr = {
      number: 1,
      title: "PR",
      url: "https://example.test/1",
      state: "open" as const,
    };
    expect(resolveThreadPr(null, null)).toBeNull();
    expect(resolveThreadPr("main", null)).toBeNull();
    expect(resolveThreadPr("main", { refName: "other", pr } as never)).toBeNull();
    expect(resolveThreadPr("main", { refName: "main", pr: null } as never)).toBeNull();
    expect(resolveThreadPr("main", { refName: "main", pr } as never)).toBe(pr);
  });

  it("maps running terminal IDs", () => {
    expect(terminalStatusFromRunningIds([])).toBeNull();
    expect(terminalStatusFromRunningIds(["terminal-1"])).toEqual({
      label: "Terminal process running",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      pulse: true,
    });
  });

  it("renders worktree and status labels in every display mode", () => {
    expect(
      renderToStaticMarkup(
        <ThreadWorktreeIndicator
          thread={{ id: thread.id, branch: null, worktreePath: "/repo/worktree" }}
        />,
      ),
    ).toContain("Worktree: worktree");
    expect(renderToStaticMarkup(<ThreadWorktreeIndicator thread={thread} />)).toContain(
      "feature/test",
    );

    const status = {
      label: "Working" as const,
      colorClass: "status-color",
      dotClass: "dot-color",
      pulse: true,
    };
    expect(renderToStaticMarkup(<ThreadStatusLabel status={status} compact />)).toContain(
      "animate-pulse",
    );
    expect(
      renderToStaticMarkup(<ThreadStatusLabel status={{ ...status, pulse: false }} />),
    ).toContain("Working");
  });

  it.each([null, "", "   "])("renders no worktree for path %j", (worktreePath) => {
    expect(
      renderToStaticMarkup(
        <ThreadWorktreeIndicator thread={{ id: thread.id, branch: "main", worktreePath }} />,
      ),
    ).toBe("");
  });

  it("renders leading PR and thread status combinations", () => {
    expect(renderToStaticMarkup(<ThreadRowLeadingStatus thread={thread} />)).toBe("");

    harness.project = { workspaceRoot: "/repo" };
    harness.gitStatus = {
      refName: "feature/test",
      sourceControlProvider: "github",
      pr: {
        number: 4,
        title: "Ready",
        url: "https://example.test/4",
        state: "open",
      },
    };
    harness.statusPill = {
      label: "Unread",
      colorClass: "unread",
      dotClass: "dot",
      pulse: false,
    };
    const both = renderToStaticMarkup(<ThreadRowLeadingStatus thread={thread} />);
    expect(both).toContain("#4 PR open: Ready");
    expect(both).toContain("Unread");

    harness.gitStatus = null;
    expect(renderToStaticMarkup(<ThreadRowLeadingStatus thread={thread} />)).toContain("Unread");
  });

  it("renders terminal and remote-environment trailing states", () => {
    expect(renderToStaticMarkup(<ThreadRowTrailingStatus thread={thread} />)).toBe("");

    harness.runningIds = ["terminal-1"];
    const terminalOnly = renderToStaticMarkup(<ThreadRowTrailingStatus thread={thread} />);
    expect(terminalOnly).toContain("Terminal process running");
    expect(terminalOnly).toContain("animate-pulse");

    harness.primaryEnvironmentId = "primary";
    harness.environment = { label: "Remote Mac" };
    expect(renderToStaticMarkup(<ThreadRowTrailingStatus thread={thread} />)).toContain(
      "Remote Mac",
    );

    harness.environment = null;
    harness.runningIds = [];
    expect(renderToStaticMarkup(<ThreadRowTrailingStatus thread={thread} />)).toContain("Remote");

    harness.primaryEnvironmentId = environmentId;
    expect(renderToStaticMarkup(<ThreadRowTrailingStatus thread={thread} />)).toBe("");
  });
});
