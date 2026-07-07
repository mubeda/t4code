/**
 * Behavior tests for NewTaskFlowProvider / useNewTaskFlow / branchBadgeLabel.
 *
 * Follows the mobile SSR test pattern (AddProjectScreen.test.tsx): render via
 * `renderToStaticMarkup`, mock the state/native seams, and drive behavior by
 * invoking the handlers captured from the rendered context value. A partial
 * `vi.mock("react")` (see apps/web ChatView.hooks.test.tsx) records useState
 * setter calls and captures useEffect bodies so the one mount effect can be run
 * manually — SSR never runs effects on its own.
 */
import type { ReactElement } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import type {
  EnvironmentId as EnvironmentIdType,
  ModelSelection,
  ServerConfig,
} from "@t3tools/contracts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface BranchView {
  data: { refs: ReadonlyArray<VcsRef> } | null;
  error: string | null;
  isPending: boolean;
  refresh: () => void;
}

interface DraftShape {
  text: string;
  attachments: ReadonlyArray<unknown>;
  modelSelection?: ModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
  workspaceSelection?: { mode: "local" | "worktree"; branch: string | null; worktreePath: string | null };
}

const h = vi.hoisted(() => {
  const emptyDraft: DraftShape = { text: "", attachments: [] };
  return {
    projects: [] as Array<unknown>,
    threads: [] as Array<unknown>,
    savedConnectionsById: {} as Record<string, { environmentId: string; environmentLabel: string }>,
    serverConfig: null as unknown,
    draft: { ...emptyDraft } as DraftShape,
    branchView: {
      data: null,
      error: null,
      isPending: false,
      refresh: () => {},
    } as BranchView,
    // recorded calls
    settingsCalls: [] as Array<{ key: string; settings: Record<string, unknown> }>,
    textCalls: [] as Array<{ key: string; value: string }>,
    replaceCalls: [] as Array<{ key: string; attachments: ReadonlyArray<unknown> }>,
    appendCalls: [] as Array<{ key: string; attachments: ReadonlyArray<unknown> }>,
    removeCalls: [] as Array<{ key: string; imageId: string }>,
    refreshCalls: 0,
    pendingErrors: [] as Array<string | null>,
    // react instrumentation
    stateCalls: [] as Array<{ index: number; initial: unknown }>,
    setStateCalls: [] as Array<{ index: number; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (initial?: unknown) => {
    const resolved = typeof initial === "function" ? (initial as () => unknown)() : initial;
    const index = h.stateCalls.length;
    h.stateCalls.push({ index, initial: resolved });
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(resolved) : next;
      h.setStateCalls.push({ index, applied });
    };
    return [resolved, setValue];
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

vi.mock("../../state/entities", () => ({
  useProjects: () => h.projects,
  useThreadShells: () => h.threads,
  useEnvironmentServerConfig: () => h.serverConfig,
}));

vi.mock("../../state/use-composer-drafts", () => ({
  useComposerDraft: (key: string | null) => (key ? h.draft : { text: "", attachments: [] }),
  setComposerDraftText: (key: string, value: string) => {
    h.textCalls.push({ key, value });
  },
  updateComposerDraftSettings: (key: string, settings: Record<string, unknown>) => {
    h.settingsCalls.push({ key, settings });
  },
  replaceComposerDraftAttachments: (key: string, attachments: ReadonlyArray<unknown>) => {
    h.replaceCalls.push({ key, attachments });
  },
  appendComposerDraftAttachments: (key: string, attachments: ReadonlyArray<unknown>) => {
    h.appendCalls.push({ key, attachments });
  },
  removeComposerDraftAttachment: (key: string, imageId: string) => {
    h.removeCalls.push({ key, imageId });
  },
}));

vi.mock("../../state/queries", () => ({
  useBranches: () => h.branchView,
}));

vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: h.savedConnectionsById }),
  setPendingConnectionError: (message: string | null) => {
    h.pendingErrors.push(message);
  },
}));

import {
  NewTaskFlowProvider,
  useNewTaskFlow,
  branchBadgeLabel,
} from "./new-task-flow-provider";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

type FlowValue = ReturnType<typeof useNewTaskFlow>;

const captured: { value: FlowValue | null } = { value: null };

function Capture(): null {
  captured.value = useNewTaskFlow();
  return null;
}

const ENV_ALPHA = EnvironmentId.make("env-alpha");
const ENV_BETA = EnvironmentId.make("env-beta");

function project(overrides: {
  readonly id?: string;
  readonly environmentId?: EnvironmentIdType;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly repositoryIdentity?: unknown;
  readonly defaultModelSelection?: ModelSelection | null;
}): EnvironmentProject {
  return {
    id: ProjectId.make(overrides.id ?? "project-1"),
    environmentId: overrides.environmentId ?? ENV_ALPHA,
    title: overrides.title ?? "Demo",
    workspaceRoot: overrides.workspaceRoot ?? "/home/dev/demo",
    repositoryIdentity: overrides.repositoryIdentity ?? null,
    defaultModelSelection: overrides.defaultModelSelection ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  } as unknown as EnvironmentProject;
}

function serverConfig(): ServerConfig {
  return {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [
          { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null },
          { slug: "gpt-4", name: "GPT-4", isCustom: false, capabilities: null },
        ],
        skills: [{ id: "skill-a", label: "Skill A" }],
      },
    ],
  } as unknown as ServerConfig;
}

function branch(overrides: Partial<VcsRef> & { name: string }): VcsRef {
  return {
    current: false,
    isDefault: false,
    worktreePath: null,
    ...overrides,
  } as VcsRef;
}

function render(): FlowValue {
  h.effects.length = 0;
  h.stateCalls.length = 0;
  h.setStateCalls.length = 0;
  captured.value = null;
  renderToStaticMarkup(
    <NewTaskFlowProvider>
      <Capture />
    </NewTaskFlowProvider>,
  );
  if (!captured.value) {
    throw new Error("context value was not captured");
  }
  return captured.value;
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  for (const effect of [...h.effects]) {
    const cleanup = effect();
    if (typeof cleanup === "function") {
      cleanups.push(cleanup);
    }
  }
  return cleanups;
}

beforeEach(() => {
  h.projects = [];
  h.threads = [];
  h.savedConnectionsById = {};
  h.serverConfig = null;
  h.draft = { text: "", attachments: [] };
  h.branchView = { data: null, error: null, isPending: false, refresh: () => { h.refreshCalls += 1; } };
  h.settingsCalls.length = 0;
  h.textCalls.length = 0;
  h.replaceCalls.length = 0;
  h.appendCalls.length = 0;
  h.removeCalls.length = 0;
  h.refreshCalls = 0;
  h.pendingErrors.length = 0;
  h.effects.length = 0;
  h.stateCalls.length = 0;
  h.setStateCalls.length = 0;
});

// ─────────────────────────────────────────────────────────────────────
// branchBadgeLabel (pure export)
// ─────────────────────────────────────────────────────────────────────

describe("branchBadgeLabel", () => {
  const proj = project({ workspaceRoot: "/repo" });

  it("labels the current branch", () => {
    expect(branchBadgeLabel({ branch: branch({ name: "main", current: true }), project: proj })).toBe(
      "current",
    );
  });

  it("labels a worktree branch when its path differs from the workspace root", () => {
    expect(
      branchBadgeLabel({
        branch: branch({ name: "feat", worktreePath: "/repo/wt" }),
        project: proj,
      }),
    ).toBe("worktree");
  });

  it("does not label a worktree that points at the workspace root", () => {
    expect(
      branchBadgeLabel({
        branch: branch({ name: "feat", worktreePath: "/repo" }),
        project: proj,
      }),
    ).toBeNull();
  });

  it("labels the default branch", () => {
    expect(
      branchBadgeLabel({ branch: branch({ name: "main", isDefault: true }), project: proj }),
    ).toBe("default");
  });

  it("labels a remote branch", () => {
    expect(
      branchBadgeLabel({ branch: branch({ name: "origin/x", isRemote: true }), project: null }),
    ).toBe("remote");
  });

  it("returns null for an ordinary branch", () => {
    expect(branchBadgeLabel({ branch: branch({ name: "topic" }), project: proj })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// useNewTaskFlow guard
// ─────────────────────────────────────────────────────────────────────

describe("useNewTaskFlow", () => {
  it("throws when used outside the provider", () => {
    function Orphan(): null {
      useNewTaskFlow();
      return null;
    }
    expect(() => renderToStaticMarkup(<Orphan />)).toThrow(
      "useNewTaskFlow must be used within NewTaskFlowProvider.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Derived context value
// ─────────────────────────────────────────────────────────────────────

describe("NewTaskFlowProvider derived state", () => {
  it("exposes empty defaults when there are no projects", () => {
    const flow = render();
    expect(flow.logicalProjects).toEqual([]);
    expect(flow.environments).toEqual([]);
    expect(flow.selectedEnvironmentId).toBeNull();
    expect(flow.selectedProject).toBeNull();
    expect(flow.selectedModel).toBeNull();
    expect(flow.selectedModelKey).toBeNull();
    expect(flow.modelOptions).toEqual([]);
    expect(flow.workspaceMode).toBe("local");
    expect(flow.runtimeMode).toBe("full-access");
    expect(flow.interactionMode).toBe("default");
    expect(flow.availableBranches).toEqual([]);
    expect(flow.filteredBranches).toEqual([]);
  });

  it("derives logical projects, environments, and the selected project", () => {
    h.projects = [
      project({ id: "p1", environmentId: ENV_ALPHA, title: "Alpha One" }),
      project({ id: "p2", environmentId: ENV_BETA, title: "Beta Two" }),
    ];
    h.savedConnectionsById = {
      [ENV_ALPHA]: { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
      // ENV_BETA intentionally absent -> filtered out of environments
    };

    const flow = render();

    expect(flow.logicalProjects).toHaveLength(2);
    expect(flow.environments).toEqual([
      { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
    ]);
    // Default selected environment is the first project's environment.
    expect(flow.selectedEnvironmentId).toBe(ENV_ALPHA);
    expect(flow.selectedProject?.id).toBe("p1");
  });

  it("builds model options and selects the default model + provider skills", () => {
    h.projects = [
      project({
        id: "p1",
        environmentId: ENV_ALPHA,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5" } as ModelSelection,
      }),
    ];
    h.savedConnectionsById = {
      [ENV_ALPHA]: { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
    };
    h.serverConfig = serverConfig();

    const flow = render();

    expect(flow.modelOptions.length).toBeGreaterThan(0);
    expect(flow.selectedModel).toEqual({ instanceId: "codex", model: "gpt-5" });
    expect(flow.selectedModelKey).toBe("codex:gpt-5");
    expect(flow.selectedModelOption?.key).toBe("codex:gpt-5");
    expect(flow.providerGroups.map((group) => group.providerKey)).toContain("codex");
    expect(flow.selectedProviderSkills).toEqual([{ id: "skill-a", label: "Skill A" }]);
  });

  it("falls back to the first model option when neither draft nor project provide a selection", () => {
    h.projects = [project({ id: "p1", environmentId: ENV_ALPHA })];
    h.savedConnectionsById = {
      [ENV_ALPHA]: { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
    };
    h.serverConfig = serverConfig();

    const flow = render();

    expect(flow.selectedModel).toEqual(flow.modelOptions[0]?.selection);
  });

  it("reads prompt/attachments/workspace fields from the active draft", () => {
    h.projects = [project({ id: "p1", environmentId: ENV_ALPHA })];
    h.savedConnectionsById = {
      [ENV_ALPHA]: { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
    };
    h.draft = {
      text: "hello world",
      attachments: [{ id: "img-1" }],
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceSelection: { mode: "worktree", branch: "feature", worktreePath: "/repo/wt" },
    };

    const flow = render();

    expect(flow.prompt).toBe("hello world");
    expect(flow.attachments).toEqual([{ id: "img-1" }]);
    expect(flow.workspaceMode).toBe("worktree");
    expect(flow.selectedBranchName).toBe("feature");
    expect(flow.selectedWorktreePath).toBe("/repo/wt");
    expect(flow.runtimeMode).toBe("approval-required");
    expect(flow.interactionMode).toBe("plan");
  });

  it("filters remote refs out of availableBranches and reflects loading state", () => {
    h.projects = [project({ id: "p1", environmentId: ENV_ALPHA })];
    h.savedConnectionsById = {
      [ENV_ALPHA]: { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
    };
    h.branchView = {
      data: {
        refs: [
          branch({ name: "main", current: true }),
          branch({ name: "origin/main", isRemote: true }),
        ],
      },
      error: null,
      isPending: true,
      refresh: () => {},
    };

    const flow = render();

    expect(flow.branchesLoading).toBe(true);
    expect(flow.availableBranches.map((ref) => ref.name)).toEqual(["main"]);
    expect(flow.filteredBranches.map((ref) => ref.name)).toEqual(["main"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Handlers off the captured value
// ─────────────────────────────────────────────────────────────────────

describe("NewTaskFlowProvider handlers", () => {
  function withSelectedProject(): FlowValue {
    h.projects = [
      project({
        id: "p1",
        environmentId: ENV_ALPHA,
        workspaceRoot: "/repo",
        defaultModelSelection: { instanceId: "codex", model: "gpt-5" } as ModelSelection,
      }),
    ];
    h.savedConnectionsById = {
      [ENV_ALPHA]: { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
    };
    h.serverConfig = serverConfig();
    return render();
  }

  const draftKey = `new-task:${ENV_ALPHA}:p1`;

  it("setProject records environment + project key state updates", () => {
    const flow = withSelectedProject();
    flow.setProject(project({ id: "p9", environmentId: ENV_BETA }));
    expect(h.setStateCalls.some((call) => call.applied === ENV_BETA)).toBe(true);
    expect(h.setStateCalls.some((call) => call.applied === `${ENV_BETA}:p9`)).toBe(true);
  });

  it("selectEnvironment sets the environment and clears the project key", () => {
    const flow = withSelectedProject();
    flow.selectEnvironment(ENV_BETA);
    expect(h.setStateCalls.some((call) => call.applied === ENV_BETA)).toBe(true);
    expect(h.setStateCalls.some((call) => call.applied === null)).toBe(true);
  });

  it("reset clears the transient selection state", () => {
    const flow = withSelectedProject();
    flow.reset();
    // reset performs five state updates; at least the null/false/"" ones land.
    expect(h.setStateCalls.some((call) => call.applied === null)).toBe(true);
    expect(h.setStateCalls.some((call) => call.applied === false)).toBe(true);
    expect(h.setStateCalls.some((call) => call.applied === "")).toBe(true);
  });

  it("setSelectedModelKey updates the draft when the option exists", () => {
    const flow = withSelectedProject();
    flow.setSelectedModelKey("codex:gpt-4");
    expect(h.settingsCalls).toHaveLength(1);
    expect(h.settingsCalls[0]?.key).toBe(draftKey);
    expect(h.settingsCalls[0]?.settings.modelSelection).toEqual({ instanceId: "codex", model: "gpt-4" });
  });

  it("setSelectedModelKey ignores a null key and an unknown option", () => {
    const flow = withSelectedProject();
    flow.setSelectedModelKey(null);
    flow.setSelectedModelKey("nope:nope");
    expect(h.settingsCalls).toEqual([]);
  });

  it("setSelectedModelOptions attaches options and can strip them", () => {
    const flow = withSelectedProject();
    flow.setSelectedModelOptions([{ id: "reasoning", value: "high" }] as never);
    expect(h.settingsCalls[0]?.settings.modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5",
      options: [{ id: "reasoning", value: "high" }],
    });

    h.settingsCalls.length = 0;
    flow.setSelectedModelOptions(undefined);
    expect(h.settingsCalls[0]?.settings.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5",
    });
  });

  it("setPrompt writes the draft text", () => {
    const flow = withSelectedProject();
    flow.setPrompt("typed text");
    expect(h.textCalls).toEqual([{ key: draftKey, value: "typed text" }]);
  });

  it("attachment helpers proxy to the draft store", () => {
    const flow = withSelectedProject();
    flow.replaceAttachments([{ id: "a" }] as never);
    flow.appendAttachments([{ id: "b" }] as never);
    flow.removeAttachment("a");
    flow.clearAttachments();
    expect(h.replaceCalls[0]).toEqual({ key: draftKey, attachments: [{ id: "a" }] });
    expect(h.appendCalls[0]).toEqual({ key: draftKey, attachments: [{ id: "b" }] });
    expect(h.removeCalls[0]).toEqual({ key: draftKey, imageId: "a" });
    // clearAttachments replaces with an empty array
    expect(h.replaceCalls.at(-1)).toEqual({ key: draftKey, attachments: [] });
  });

  it("setWorkspaceMode persists the mode with the current branch/worktree", () => {
    h.draft = {
      text: "",
      attachments: [],
      workspaceSelection: { mode: "local", branch: "main", worktreePath: "/repo/wt" },
    };
    const flow = withSelectedProject();
    flow.setWorkspaceMode("worktree");
    expect(h.settingsCalls[0]?.settings.workspaceSelection).toEqual({
      mode: "worktree",
      branch: "main",
      worktreePath: "/repo/wt",
    });
  });

  it("selectBranch persists the branch and normalizes the worktree path", () => {
    const flow = withSelectedProject();
    // worktreePath differs from the workspace root -> kept
    flow.selectBranch(branch({ name: "feature", worktreePath: "/repo/wt" }));
    expect(h.settingsCalls[0]?.settings.workspaceSelection).toMatchObject({
      branch: "feature",
      worktreePath: "/repo/wt",
    });

    h.settingsCalls.length = 0;
    // worktreePath equal to workspace root -> normalized to null
    flow.selectBranch(branch({ name: "main", worktreePath: "/repo" }));
    expect(h.settingsCalls[0]?.settings.workspaceSelection).toMatchObject({
      branch: "main",
      worktreePath: null,
    });

    h.settingsCalls.length = 0;
    // no worktree path at all -> null
    flow.selectBranch(branch({ name: "topic" }));
    expect(h.settingsCalls[0]?.settings.workspaceSelection).toMatchObject({
      branch: "topic",
      worktreePath: null,
    });
  });

  it("loadBranches clears the pending error and refreshes branch state", async () => {
    let refreshed = 0;
    h.branchView = {
      data: null,
      error: null,
      isPending: false,
      refresh: () => {
        refreshed += 1;
      },
    };
    const flow = withSelectedProject();
    await flow.loadBranches();
    expect(h.pendingErrors).toEqual([null]);
    expect(refreshed).toBe(1);
  });

  it("setRuntimeMode and setInteractionMode persist to the draft", () => {
    const flow = withSelectedProject();
    flow.setRuntimeMode("auto-accept-edits");
    flow.setInteractionMode("plan");
    expect(h.settingsCalls[0]?.settings).toEqual({ runtimeMode: "auto-accept-edits" });
    expect(h.settingsCalls[1]?.settings).toEqual({ interactionMode: "plan" });
  });

  it("setSubmitting / setBranchQuery / setExpandedProvider record state updates", () => {
    const flow = withSelectedProject();
    flow.setSubmitting(true);
    flow.setBranchQuery("main");
    flow.setExpandedProvider("codex");
    expect(h.setStateCalls.some((call) => call.applied === true)).toBe(true);
    expect(h.setStateCalls.some((call) => call.applied === "main")).toBe(true);
    expect(h.setStateCalls.some((call) => call.applied === "codex")).toBe(true);
  });

  it("no-op guards: handlers do nothing without a selected project draft key", () => {
    // No projects -> selectedProject null -> selectedProjectDraftKey null.
    const flow = render();
    flow.setPrompt("x");
    flow.setSelectedModelKey("codex:gpt-5");
    flow.replaceAttachments([{ id: "a" }] as never);
    flow.appendAttachments([{ id: "b" }] as never);
    flow.removeAttachment("a");
    flow.clearAttachments();
    flow.setWorkspaceMode("worktree");
    flow.selectBranch(branch({ name: "main" }));
    flow.setRuntimeMode("full-access");
    flow.setInteractionMode("plan");
    flow.setSelectedModelOptions(undefined);
    expect(h.textCalls).toEqual([]);
    expect(h.settingsCalls).toEqual([]);
    expect(h.replaceCalls).toEqual([]);
    expect(h.appendCalls).toEqual([]);
    expect(h.removeCalls).toEqual([]);
  });

  it("loadBranches is a no-op without a selected project", async () => {
    const flow = render();
    await flow.loadBranches();
    expect(h.pendingErrors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Mount effect: auto-select a preferred branch in worktree mode
// ─────────────────────────────────────────────────────────────────────

describe("NewTaskFlowProvider worktree branch effect", () => {
  function seedWorktree(refs: ReadonlyArray<VcsRef>): void {
    h.projects = [project({ id: "p1", environmentId: ENV_ALPHA, workspaceRoot: "/repo" })];
    h.savedConnectionsById = {
      [ENV_ALPHA]: { environmentId: ENV_ALPHA, environmentLabel: "Alpha" },
    };
    h.draft = {
      text: "",
      attachments: [],
      workspaceSelection: { mode: "worktree", branch: null, worktreePath: null },
    };
    h.branchView = { data: { refs }, error: null, isPending: false, refresh: () => {} };
  }

  it("selects the current branch when none is chosen yet", () => {
    seedWorktree([
      branch({ name: "topic" }),
      branch({ name: "main", current: true }),
    ]);
    render();
    runEffects();
    expect(h.settingsCalls.at(-1)?.settings.workspaceSelection).toMatchObject({ branch: "main" });
  });

  it("falls back to the default branch when there is no current branch", () => {
    seedWorktree([
      branch({ name: "topic" }),
      branch({ name: "release", isDefault: true }),
    ]);
    render();
    runEffects();
    expect(h.settingsCalls.at(-1)?.settings.workspaceSelection).toMatchObject({ branch: "release" });
  });

  it("does nothing when a branch is already selected", () => {
    seedWorktree([branch({ name: "main", current: true })]);
    h.draft = {
      text: "",
      attachments: [],
      workspaceSelection: { mode: "worktree", branch: "existing", worktreePath: null },
    };
    render();
    runEffects();
    expect(h.settingsCalls).toEqual([]);
  });

  it("does nothing in local workspace mode", () => {
    seedWorktree([branch({ name: "main", current: true })]);
    h.draft = {
      text: "",
      attachments: [],
      workspaceSelection: { mode: "local", branch: null, worktreePath: null },
    };
    render();
    runEffects();
    expect(h.settingsCalls).toEqual([]);
  });
});
