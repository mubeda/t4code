"use client";

// TODO(orca-port): this is a first working pass wired against the plan in
// .superpowers/orca-port/00-port-plan.md and w2-findings.md. Several exact
// field/prop names are best-effort (marked below) and should be re-verified
// against tsgo/runtime once S1's pinned interfaces (kind field, vcs.clone)
// land and this can be re-tested end-to-end.

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t4code/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t4code/contracts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
} from "@t4code/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { newThreadId } from "~/lib/utils";
import { applyProviderInstanceSettings, deriveProviderInstanceEntries } from "~/providerInstances";
import { resolveProviderSessionSelectionForInstance } from "~/providerSessionSelection";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import {
  buildSmartRows,
  detectSmartMode,
  filterRefsByQuery,
  getCreateWorktreeDisabled,
  parseGitHubWorkItem,
  resolveWorktreeCreateInput,
  type GitHubWorkItemRef,
  type RefLike,
  type SmartRow,
  type WorktreeNameMode,
} from "./CreateWorktreeDialog.logic";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "./ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface CreateWorktreeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly defaultProjectId?: ProjectId | null;
}

const TAB_OPTIONS: ReadonlyArray<{ value: WorktreeNameMode; label: string }> = [
  { value: "smart", label: "Smart" },
  { value: "github", label: "GitHub" },
  { value: "branch", label: "Branch" },
  { value: "name", label: "Name" },
];

export function CreateWorktreeDialog({
  open,
  onOpenChange,
  defaultProjectId = null,
}: CreateWorktreeDialogProps) {
  const navigate = useNavigate();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const projects = useProjects();
  const serverConfigs = useServerConfigs();

  const [projectId, setProjectId] = useState<ProjectId | null>(defaultProjectId);
  const [mode, setMode] = useState<WorktreeNameMode>("smart");
  const [nameText, setNameText] = useState("");
  const [selectedBranchRefName, setSelectedBranchRefName] = useState<string | null>(null);
  const [baseBranchOverride, setBaseBranchOverride] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // A fresh query/tab invalidates whatever branch row was previously picked.
  useEffect(() => {
    setSelectedBranchRefName(null);
  }, [nameText, mode]);

  useEffect(() => {
    if (!open) return;
    setProjectId((current) => current ?? defaultProjectId ?? projects[0]?.id ?? null);
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, defaultProjectId, projects]);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId],
  );
  const environmentId: EnvironmentId | null = project?.environmentId ?? null;
  const cwd = project?.workspaceRoot ?? null;

  const branchesEnabled =
    (mode === "branch" || mode === "smart") && cwd !== null && environmentId !== null;
  const refsQuery = useEnvironmentQuery(
    branchesEnabled && environmentId !== null && cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, query: nameText.trim() || undefined },
        })
      : null,
  );
  // TODO(orca-port): confirm VcsListRefsResult field name is `refs`.
  const refs: ReadonlyArray<RefLike> = refsQuery.data?.refs ?? [];

  const githubItem: GitHubWorkItemRef | null =
    mode === "github" || mode === "smart" ? parseGitHubWorkItem(nameText) : null;

  const smartRows: SmartRow[] = useMemo(
    () => (mode === "smart" ? buildSmartRows({ query: nameText, refs }) : []),
    [mode, nameText, refs],
  );
  const branchRows = useMemo(
    () => (mode === "branch" ? filterRefsByQuery(refs, nameText) : []),
    [mode, nameText, refs],
  );
  const smartDetectedMode = useMemo(
    () => (mode === "smart" ? detectSmartMode(nameText, refs) : mode),
    [mode, nameText, refs],
  );

  const serverConfig = environmentId ? serverConfigs.get(environmentId) : undefined;
  const providers = useMemo(() => {
    if (!serverConfig) return [];
    return applyProviderInstanceSettings(
      deriveProviderInstanceEntries(serverConfig.providers),
      serverConfig.settings,
    ).filter((entry) => entry.enabled && entry.installed);
  }, [serverConfig]);

  useEffect(() => {
    if (instanceId && providers.some((p) => p.instanceId === instanceId)) return;
    const first = providers[0];
    setInstanceId(first?.instanceId ?? null);
  }, [providers, instanceId]);

  const resolution = useMemo(
    () =>
      resolveWorktreeCreateInput({
        mode,
        nameText,
        selectedBranchRefName,
        githubItem,
        advancedBaseBranchOverride: baseBranchOverride || null,
        defaultBaseBranch: null,
      }),
    [mode, nameText, selectedBranchRefName, githubItem, baseBranchOverride],
  );

  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createDisabled = getCreateWorktreeDisabled({
    hasProject: project !== null,
    resolution,
    isSubmitting,
  });

  const resetForNextCreate = useCallback(() => {
    setNameText("");
    setSelectedBranchRefName(null);
    setFormError(null);
    window.requestAnimationFrame(() => nameInputRef.current?.focus());
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!project || !environmentId || !cwd || !resolution) {
      setFormError("Choose a project and a name/branch to create the worktree from.");
      return;
    }
    setFormError(null);
    setIsSubmitting(true);
    try {
      const baseRefName = resolution.baseRefName ?? "HEAD";
      // Pinned interface (00-port-plan.md item 6 / w2-findings.md): refName is
      // the REQUIRED base ref to check out from; newRefName is the branch
      // being created; path:null lets the server compute the worktree path.
      const worktreeResult = await createWorktree({
        environmentId,
        input: {
          cwd,
          refName: baseRefName,
          newRefName: resolution.branchName,
          baseRefName,
          path: null,
        },
      });
      if (worktreeResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(worktreeResult)) {
          const error = squashAtomCommandFailure(worktreeResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to create worktree",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const worktreePath = worktreeResult.value.worktree.path;
      const threadId = newThreadId();
      const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
      const targetInstanceId =
        (instanceId ? ProviderInstanceId.make(instanceId) : null) ??
        project.defaultModelSelection?.instanceId ??
        ProviderInstanceId.make("codex");
      const resolvedDefault = resolveProviderSessionSelectionForInstance({
        instanceId: targetInstanceId,
        providers: serverConfig?.providers ?? [],
        settings,
        projectSelection: project.defaultModelSelection,
      });
      if (resolvedDefault.fallback) {
        console.warn("Provider session default fallback", resolvedDefault.fallback);
      }

      const threadResult = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: resolution.branchName,
          modelSelection: resolvedDefault.modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: resolution.branchName,
          worktreePath,
        },
      });
      if (threadResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(threadResult)) {
          const error = squashAtomCommandFailure(threadResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Worktree created but thread creation failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (createMore) {
        resetForNextCreate();
        return;
      }

      onOpenChange(false);
      // Verified against routeTree.gen.ts: "/$environmentId/$threadId" is the
      // FileRoutesByTo id for routes/_chat.$environmentId.$threadId.tsx.
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    project,
    environmentId,
    cwd,
    resolution,
    createWorktree,
    createThread,
    instanceId,
    providers,
    serverConfig,
    createMore,
    resetForNextCreate,
    onOpenChange,
    navigate,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (!createDisabled) void handleSubmit();
      }
    },
    [createDisabled, handleSubmit],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>Create worktree</DialogTitle>
          <DialogDescription>
            Create a new worktree and thread from a project, branch, or GitHub issue/PR.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-foreground text-xs font-medium">Project</span>
            <Select
              modal={false}
              value={projectId ?? undefined}
              onValueChange={(value) => setProjectId(value as ProjectId)}
              items={projects.map((p) => ({ value: p.id, label: p.title }))}
            >
              <SelectTrigger aria-label="Project">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          </label>

          <div className="grid gap-1.5">
            {/* TODO(orca-port): swap for ui/toggle-group's segmented control
                once its single-select value API (string vs string[]) is
                confirmed; plain buttons are a safe first pass. */}
            <div className="flex gap-1">
              {TAB_OPTIONS.map((tab) => (
                <Button
                  key={tab.value}
                  type="button"
                  size="sm"
                  variant={mode === tab.value ? "default" : "outline"}
                  onClick={() => setMode(tab.value)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>

            <Input
              ref={nameInputRef}
              placeholder={
                mode === "github"
                  ? "#1234 or a GitHub issue/PR URL"
                  : mode === "branch"
                    ? "Search branches"
                    : mode === "name"
                      ? "Worktree / branch name"
                      : "Type a name, #1234, or a branch"
              }
              value={nameText}
              onChange={(event) => setNameText(event.target.value)}
            />

            {mode === "smart" && smartRows.length > 0 ? (
              <div className="border-border/70 rounded-lg border">
                {smartRows.map((row) => (
                  <button
                    key={
                      row.kind === "github"
                        ? `github-${row.item.number}`
                        : row.kind === "branch"
                          ? `branch-${row.refName}`
                          : "use-name"
                    }
                    type="button"
                    className={cn(
                      "hover:bg-accent flex w-full items-center justify-between px-3 py-1.5 text-left text-sm",
                      row.kind === "branch" && row.refName === selectedBranchRefName && "bg-accent",
                    )}
                    onClick={() => {
                      if (row.kind === "branch") setSelectedBranchRefName(row.refName);
                    }}
                  >
                    <span>
                      {row.kind === "github"
                        ? `GitHub #${row.item.number}`
                        : row.kind === "branch"
                          ? row.refName
                          : `Use "${row.name}"`}
                    </span>
                    <span className="text-muted-foreground text-xs capitalize">{row.kind}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {mode === "branch" && branchRows.length > 0 ? (
              <div className="border-border/70 max-h-48 overflow-y-auto rounded-lg border">
                {branchRows.map((ref) => (
                  <button
                    key={ref.name}
                    type="button"
                    className={cn(
                      "hover:bg-accent flex w-full items-center px-3 py-1.5 text-left text-sm",
                      ref.name === selectedBranchRefName && "bg-accent",
                    )}
                    onClick={() => setSelectedBranchRefName(ref.name)}
                  >
                    {ref.name}
                  </button>
                ))}
              </div>
            ) : null}

            {mode === "smart" ? (
              <p className="text-muted-foreground text-xs">
                Interpreting as: <span className="font-medium capitalize">{smartDetectedMode}</span>
              </p>
            ) : null}
          </div>

          <label className="grid gap-1.5">
            <span className="text-foreground text-xs font-medium">Agent</span>
            <Select
              modal={false}
              value={instanceId ?? undefined}
              onValueChange={(value) => setInstanceId(value as string)}
              items={providers.map((p) => ({
                value: p.instanceId,
                label: p.displayName,
              }))}
            >
              <SelectTrigger aria-label="Agent">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  <SelectGroupLabel>Agent</SelectGroupLabel>
                  {providers.map((p) => (
                    <SelectItem key={p.instanceId} value={p.instanceId}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          </label>

          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-sm font-medium">
              {showAdvanced ? "Hide advanced" : "Advanced"}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <label className="grid gap-1.5 pt-2">
                <span className="text-foreground text-xs font-medium">Base branch override</span>
                <Input
                  placeholder="Defaults to the current branch"
                  value={baseBranchOverride}
                  onChange={(event) => setBaseBranchOverride(event.target.value)}
                />
              </label>
            </CollapsiblePanel>
          </Collapsible>

          {formError ? <p className="text-destructive text-xs">{formError}</p> : null}
        </DialogPanel>
        <DialogFooter className="items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={createMore} onCheckedChange={setCreateMore} />
            Create more
          </label>
          <Button type="button" disabled={createDisabled} onClick={() => void handleSubmit()}>
            {isSubmitting ? "Creating..." : "Create worktree"}
            <Kbd>Ctrl+Enter</Kbd>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
