import { EnvironmentId, ProjectId, ThreadId } from "@t4code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  drawerProps: null as Record<string, unknown> | null,
}));

vi.mock("~/state/entities", () => ({
  useThread: () => ({
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    worktreePath: "/repo/.t4code/worktrees/feature",
  }),
  useProject: () => ({ workspaceRoot: "/repo" }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (state: { getDraftThreadByRef: () => null }) => unknown) =>
    selector({ getDraftThreadByRef: () => null }),
}));
vi.mock("~/state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [
    {
      target: { terminalId: "term-1" },
      state: {
        summary: {
          cwd: "/repo/.t4code/worktrees/stale",
          worktreePath: "/repo/.t4code/worktrees/stale",
          label: "stale process",
        },
      },
    },
  ],
}));
vi.mock("@t4code/shared/projectScripts", () => ({
  projectScriptCwd: ({ worktreePath }: { worktreePath: string | null }) => worktreePath ?? "/repo",
  projectScriptRuntimeEnv: () => ({ T4CODE_PROJECT_ROOT: "/repo" }),
}));
vi.mock("./ThreadTerminalDrawer", () => ({
  default: (props: Record<string, unknown>) => {
    h.drawerProps = props;
    return <div data-terminal-drawer />;
  },
}));

import { CenterTerminalPanel } from "./CenterTerminalPanel";

beforeEach(() => {
  h.drawerProps = null;
});

describe("CenterTerminalPanel", () => {
  it("uses the host worktree and forwards the provider command", () => {
    const surface = {
      id: "terminal:term-1",
      kind: "terminal",
      terminalId: "term-1",
      label: "Codex Terminal",
      command: {
        executable: "/opt/codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        label: "Codex Terminal",
      },
    } as const;
    renderToStaticMarkup(
      <CenterTerminalPanel
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        surface={surface}
        launchContext={{
          cwd: "/repo/.t4code/worktrees/feature",
          worktreePath: "/repo/.t4code/worktrees/feature",
          runtimeEnv: { T4CODE_PROJECT_ROOT: "/repo" },
        }}
        keybindings={{} as never}
        focusRequestId={1}
        onAddTerminalContext={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(h.drawerProps).toMatchObject({
      cwd: "/repo/.t4code/worktrees/feature",
      worktreePath: "/repo/.t4code/worktrees/feature",
      terminalIds: ["term-1"],
    });
    expect(
      (h.drawerProps!["terminalCommandsById"] as ReadonlyMap<string, unknown>).get("term-1"),
    ).toEqual(surface.command);
    expect(
      (h.drawerProps!["terminalLabelsById"] as ReadonlyMap<string, string>).get("term-1"),
    ).toBe("Codex Terminal");
  });

  it("does not mount an attach layer without a resolved live-thread launch context", () => {
    renderToStaticMarkup(
      <CenterTerminalPanel
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        surface={{
          id: "terminal:term-1",
          kind: "terminal",
          terminalId: "term-1",
        }}
        launchContext={null}
        keybindings={{} as never}
        focusRequestId={1}
        onAddTerminalContext={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(h.drawerProps).toBeNull();
  });
});
