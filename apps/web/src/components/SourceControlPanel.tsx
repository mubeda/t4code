import type {
  GitStackedAction,
  ScopedThreadRef,
  VcsStagingArea,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  ChevronDownIcon,
  CloudUploadIcon,
  DownloadIcon,
  GitCommitIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useDiffPanelStore } from "~/diffPanelStore";
import { usePreferredEditor } from "~/editorPreferences";
import { openPullRequestLink } from "~/lib/openPullRequestLink";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsDiscardAction,
  useVcsGenerateCommitMessageAction,
  useVcsPullAction,
  useVcsStageAction,
  useVcsUnstageAction,
} from "~/lib/sourceControlActions";
import { cn, randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import {
  selectThreadSourceControlDraft,
  useSourceControlPanelStore,
} from "~/sourceControlPanelStore";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerAvailableEditorsAtom } from "~/state/server";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { joinWorkspacePath } from "./files/FileTreeContextMenu.logic";
import {
  buildMenuItems,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
} from "./GitActionsControl.logic";
import { SourceControlCommits } from "./SourceControlCommits";
import {
  buildSourceControlMenuItems,
  resolveSourceControlPrimaryAction,
  type SourceControlMenuItem,
} from "./SourceControlPrimaryAction.logic";
import {
  discardPathsOf,
  groupFilesByArea,
  isFileStaged,
  type PendingDiscard,
  resolveDiscardDialogCopy,
  resolveStagingToggleAction,
  resolveVsBaseLabel,
  summarizeChangeSelection,
  type WorkingTreeFile,
  workingTreeFiles,
} from "./SourceControlPanel.logic";
import { SourceControlSection } from "./SourceControlSection";

interface SourceControlPanelProps {
  mode: DiffPanelMode;
  threadRef: ScopedThreadRef;
  gitCwd: string | null;
}

const RUNNING_ACTIONS = [
  "runStackedAction",
  "pull",
  "stageFiles",
  "unstageFiles",
  "discardFiles",
] as const;

// Legacy servers (no staging areas) don't support the stage/unstage RPCs, so
// their single flat section renders no checkbox and never invokes onToggle.
const LEGACY_NOOP_TOGGLE = () => {};

function isDefaultBranchConfirmable(
  action: GitStackedAction,
): action is DefaultBranchConfirmableAction {
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export default function SourceControlPanel({ mode, threadRef, gitCwd }: SourceControlPanelProps) {
  const environmentId = threadRef.environmentId;
  const scope = useMemo(() => ({ environmentId, cwd: gitCwd }), [environmentId, gitCwd]);

  const statusQuery = useEnvironmentQuery(
    gitCwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }),
  );
  const status: VcsStatusResult | null = statusQuery.data ?? null;

  const draft = useSourceControlPanelStore((store) =>
    selectThreadSourceControlDraft(store.byThreadKey, threadRef),
  );
  const setMessage = useSourceControlPanelStore((store) => store.setMessage);
  const clearDraft = useSourceControlPanelStore((store) => store.clearDraft);

  const runAction = useGitStackedAction(scope);
  const pullAction = useVcsPullAction(scope);
  const stageAction = useVcsStageAction(scope);
  const unstageAction = useVcsUnstageAction(scope);
  const discardAction = useVcsDiscardAction(scope);
  const generateAction = useVcsGenerateCommitMessageAction(scope);
  const generationTokenRef = useRef(0);
  const isBusy = useSourceControlActionRunning(scope, RUNNING_ACTIONS);

  const [pendingConfirm, setPendingConfirm] = useState<{
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
  } | null>(null);
  // Files staged for discard, awaiting the destructive-action confirm dialog.
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  // Bumped on every successful git action so <SourceControlCommits> refetches.
  const [commitSignal, setCommitSignal] = useState(0);

  const files = useMemo(() => workingTreeFiles(status), [status]);
  const groups = useMemo(() => groupFilesByArea(files), [files]);
  // Legacy servers omit the optional `area` field; when none carry it we fall
  // back to Plan-01 behavior (one flat list, commit by explicit filePaths).
  const hasAreas = useMemo(() => files.some((file) => file.area !== undefined), [files]);
  const generateFilePaths = useMemo(() => {
    const staged = files.filter((file) => file.area === "staged").map((file) => file.path);
    return staged.length > 0 ? staged : files.map((file) => file.path);
  }, [files]);
  const summary = useMemo(() => summarizeChangeSelection(files), [files]);
  // Stable clock for relative commit timestamps: only advances when a commit
  // succeeds, not on every keystroke in the message box.
  const nowMs = useMemo(() => Date.now(), [commitSignal]);
  const presentation = useMemo(
    () => getSourceControlPresentation(status?.sourceControlProvider),
    [status?.sourceControlProvider],
  );
  const terminology = presentation.terminology;
  const isDefaultRef = status?.isDefaultRef ?? false;
  const hasPrimaryRemote = status?.hasPrimaryRemote ?? false;
  const vsBaseLabel = useMemo(() => resolveVsBaseLabel(status), [status]);

  // Legacy servers (no staging areas) keep the chat-header cascade
  // (commit_push-first, commit-by-filePaths). The primary button and dropdown
  // below fork on `hasAreas`: this pair drives the legacy branch unchanged.
  const quickAction = useMemo(
    () => resolveQuickAction(status, isBusy, isDefaultRef, hasPrimaryRemote),
    [status, isBusy, isDefaultRef, hasPrimaryRemote],
  );
  const menuItems = useMemo(
    () => buildMenuItems(status, isBusy, hasPrimaryRemote),
    [status, isBusy, hasPrimaryRemote],
  );

  // Staging-area servers use the commit-first Source Control ladder (staged ->
  // Commit, else Stage All, else the remote ladder).
  const stagedCount = groups.staged.length;
  const stageableCount = groups.unstaged.length + groups.untracked.length;
  const primaryActionInput = useMemo(
    () => ({
      gitStatus: status,
      isBusy,
      isDefaultRef,
      hasPrimaryRemote,
      stagedCount,
      stageableCount,
    }),
    [status, isBusy, isDefaultRef, hasPrimaryRemote, stagedCount, stageableCount],
  );
  const primaryAction = useMemo(
    () => resolveSourceControlPrimaryAction(primaryActionInput),
    [primaryActionInput],
  );
  const scMenuItems = useMemo(
    () => buildSourceControlMenuItems(primaryActionInput),
    [primaryActionInput],
  );

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimaryEnv = primaryEnvironmentId !== null && environmentId === primaryEnvironmentId;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "open in editor");

  const threadToastData = useMemo(() => ({ threadRef }), [threadRef]);

  const runGitAction = useCallback(
    async (action: GitStackedAction, options?: { skipConfirm?: boolean }) => {
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      if (
        !options?.skipConfirm &&
        isDefaultBranchConfirmable(action) &&
        requiresDefaultBranchConfirmation(action, isDefaultRef) &&
        status?.refName
      ) {
        setPendingConfirm({
          action,
          branchName: status.refName,
          includesCommit:
            actionCanCommit && (action === "commit_push" ? status.hasWorkingTreeChanges : true),
        });
        return;
      }

      const message = draft.message.trim();
      // Commit semantics:
      //  - Real staging server (hasAreas): commit the staged index as-is; never
      //    send filePaths (which would trigger the legacy reset+add path).
      //  - Legacy server (no areas): commit by passing every path explicitly.
      //  - Non-commit actions (push/create_pr): send neither.
      const commitInput: { commitStagedIndexAsIs?: true; filePaths?: string[] } = actionCanCommit
        ? hasAreas
          ? { commitStagedIndexAsIs: true }
          : files.length > 0
            ? { filePaths: files.map((file) => file.path) }
            : {}
        : {};
      const toastId = toastManager.add({
        type: "loading",
        title: "Running source control action…",
        description: "Waiting for Git…",
        timeout: 0,
        data: threadToastData,
      });
      const result = await runAction.run({
        actionId: randomUUID(),
        action,
        ...(message ? { commitMessage: message } : {}),
        ...commitInput,
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(toastId);
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            data: threadToastData,
          }),
        );
        return;
      }
      // Commit succeeded: clear the drafted message.
      if (actionCanCommit) {
        clearDraft(threadRef);
      }
      // Refresh the commits list (and the relative-time clock) after any success.
      setCommitSignal((value) => value + 1);
      toastManager.update(toastId, {
        type: "success",
        title: result.value.toast.title,
        description: result.value.toast.description,
        timeout: 0,
        data: { ...threadToastData, dismissAfterVisibleMs: 10_000 },
      });
    },
    [
      clearDraft,
      draft.message,
      files,
      hasAreas,
      isDefaultRef,
      runAction,
      status,
      threadRef,
      threadToastData,
    ],
  );

  const runPull = useCallback(async () => {
    const toastId = toastManager.add({
      type: "loading",
      title: "Pulling…",
      timeout: 0,
      data: threadToastData,
    });
    const result = await pullAction.run();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "error",
          title: "Pull failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        }),
      );
      return;
    }
    toastManager.update(toastId, {
      type: "success",
      title: result.value.status === "pulled" ? "Pulled" : "Already up to date",
      timeout: 0,
      data: threadToastData,
    });
  }, [pullAction, threadToastData]);

  const surfaceFileActionFailure = useCallback(
    (result: Awaited<ReturnType<typeof stageAction.run>>, title: string) => {
      if (result._tag !== "Failure") return;
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        }),
      );
    },
    [threadToastData],
  );

  const runStage = useCallback(
    async (filePaths: string[]) => {
      surfaceFileActionFailure(await stageAction.run(filePaths), "Could not stage files");
    },
    [stageAction, surfaceFileActionFailure],
  );

  const runUnstage = useCallback(
    async (filePaths: string[]) => {
      surfaceFileActionFailure(await unstageAction.run(filePaths), "Could not unstage files");
    },
    [unstageAction, surfaceFileActionFailure],
  );

  const runDiscard = useCallback(
    async (filePaths: readonly string[]) => {
      surfaceFileActionFailure(await discardAction.run([...filePaths]), "Could not discard files");
    },
    [discardAction, surfaceFileActionFailure],
  );

  // Per-file checkbox toggle (VS Code-style staging): resolve stage vs.
  // unstage from the file's actual area, then reuse the same per-panel
  // action hooks (busy-disable + failure toasts) as the bulk section buttons.
  const onToggleFile = useCallback(
    (path: string) => {
      const file = files.find((candidate) => candidate.path === path);
      if (resolveStagingToggleAction(file?.area) === "unstage") {
        void runUnstage([path]);
      } else {
        void runStage([path]);
      }
    },
    [files, runStage, runUnstage],
  );

  const onGenerate = useCallback(async () => {
    const token = generationTokenRef.current + 1;
    generationTokenRef.current = token;
    const result = await generateAction.run({ filePaths: generateFilePaths });
    if (generationTokenRef.current !== token) return; // canceled/superseded
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not generate a commit message",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        }),
      );
      return;
    }
    if (result.value.message.trim().length > 0) {
      setMessage(threadRef, result.value.message);
    }
  }, [generateAction, generateFilePaths, setMessage, threadRef, threadToastData]);

  const cancelGenerate = useCallback(() => {
    // There is no clean client-side interrupt path for this RPC: unlike
    // thread turns (which have a dedicated `thread.turn.interrupt` command
    // the server honors), `vcs.generateCommitMessage` is a plain unary RPC
    // run through createEnvironmentRpcCommand -> Effect.runPromiseExit, which
    // doesn't expose a Fiber/AbortSignal handle back to the caller, and no
    // interrupt RPC exists for it in the contract. So stop = ignore result;
    // the RPC keeps running and completes server-side.
    generationTokenRef.current += 1;
  }, []);

  const openPr = useCallback(() => {
    const api = readLocalApi();
    const prUrl = status?.pr?.state === "open" ? status.pr.url : null;
    if (!api || !prUrl) return;
    void openPullRequestLink(api.shell, prUrl);
  }, [status]);

  const onPrimaryAction = useCallback(() => {
    if (quickAction.kind === "open_pr") return openPr();
    if (quickAction.kind === "run_pull") return void runPull();
    if (quickAction.kind === "run_action" && quickAction.action) {
      return void runGitAction(quickAction.action);
    }
    // open_publish / show_hint: no-op here (surfaced as disabled below).
  }, [openPr, quickAction, runGitAction, runPull]);

  // Commit-first ladder dispatch (staging-area servers). Commit-family actions
  // route through runGitAction, which holds the ledger guard (commit the staged
  // index as-is via commitStagedIndexAsIs, never filePaths) and the
  // default-branch confirm dialog.
  const onScPrimaryAction = useCallback(() => {
    switch (primaryAction.kind) {
      case "commit":
      case "push":
      case "create_pr":
        if (primaryAction.stackedAction) void runGitAction(primaryAction.stackedAction);
        return;
      case "stage_all":
        void runStage([...groups.unstaged, ...groups.untracked].map((file) => file.path));
        return;
      case "pull":
        void runPull();
        return;
      case "open_pr":
        openPr();
        return;
      // publish / sync_hint / none: disabled below, no-op here.
    }
  }, [primaryAction, runGitAction, runStage, runPull, openPr, groups]);

  const onScMenuItem = useCallback(
    (item: SourceControlMenuItem) => {
      switch (item.kind) {
        case "run_stacked":
          if (item.stackedAction) void runGitAction(item.stackedAction);
          return;
        case "run_pull":
          void runPull();
          return;
        case "open_pr":
          openPr();
          return;
        case "open_publish":
          // The publish wizard lives in the (frozen) chat-header GitActionsControl;
          // the panel renders this item disabled and no-ops here.
          return;
      }
    },
    [openPr, runGitAction, runPull],
  );

  const onRequestDiscardFile = useCallback((file: WorkingTreeFile) => {
    setPendingDiscard({ kind: "entry", file });
  }, []);

  const onCopyPath = useCallback(
    (path: string, relative: boolean) => {
      // Copy Path yields the absolute path (root joined with the native
      // separator); Copy Relative Path yields the tree-relative path as-is.
      // Without a known root an absolute path can't be built, so fall back to
      // the relative path.
      const text = relative || gitCwd === null ? path : joinWorkspacePath(gitCwd, path);
      void navigator.clipboard.writeText(text);
    },
    [gitCwd],
  );

  const onOpenExternalEditor = useCallback(
    (path: string) => {
      if (!preferredEditor || gitCwd === null) return;
      // openInEditor opens the given path in the editor (mirrors FileBrowserPanel):
      // a file path opens that file, a directory opens the folder.
      void openInEditor({
        environmentId,
        input: { cwd: joinWorkspacePath(gitCwd, path), editor: preferredEditor },
      });
    },
    [environmentId, gitCwd, openInEditor, preferredEditor],
  );

  const openFileInDiff = useCallback(
    (_path: string, area?: VcsStagingArea) => {
      useRightPanelStore.getState().open(threadRef, "diff");
      // The "unstaged" scope is a worktree-vs-index diff, which is empty for a
      // fully staged file — so staged rows open the "branch" scope (branch-vs-base
      // includes the staged changes) while unstaged/untracked keep the worktree
      // scope. FOLLOW-UP: a dedicated staged-vs-HEAD (git diff --cached) diff
      // source would show a staged row's exact staged hunks (see scc-progress.md).
      useDiffPanelStore
        .getState()
        .selectGitScope(threadRef, area === "staged" ? "branch" : "unstaged");
    },
    [threadRef],
  );

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate text-sm font-medium">{status?.refName ?? "Source Control"}</span>
      {vsBaseLabel ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{vsBaseLabel}</span>
      ) : null}
      {status?.pr?.state === "open" ? (
        <button
          type="button"
          onClick={openPr}
          className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {terminology.shortLabel} #{status.pr.number}
        </button>
      ) : null}
      {status && (status.aheadCount > 0 || status.behindCount > 0) ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {status.aheadCount > 0 ? `↑${status.aheadCount}` : ""}{" "}
          {status.behindCount > 0 ? `↓${status.behindCount}` : ""}
        </span>
      ) : null}
    </div>
  );

  const requiresStaged =
    quickAction.kind === "run_action" && quickAction.action?.startsWith("commit") === true;
  // Real staging server gates commit on the staged set; a legacy server (no
  // areas) gates on there being any changes at all.
  const commitGateUnmet = hasAreas
    ? files.length > 0 && groups.staged.length === 0
    : files.length === 0;
  const primaryDisabled =
    isBusy ||
    quickAction.disabled ||
    quickAction.kind === "open_publish" ||
    (requiresStaged && commitGateUnmet);
  const pendingConfirmCopy = pendingConfirm
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingConfirm.action,
        branchName: pendingConfirm.branchName,
        includesCommit: pendingConfirm.includesCommit,
        terminology,
      })
    : null;
  const pendingDiscardCopy = pendingDiscard ? resolveDiscardDialogCopy(pendingDiscard) : null;

  // The resolver already returns disabled when busy / diverged / up-to-date;
  // publish has no wired flow in the panel so it's disabled too.
  const scPrimaryDisabled = primaryAction.disabled || primaryAction.kind === "publish";
  const scPrimaryLabel =
    primaryAction.count !== undefined
      ? `${primaryAction.label} (${primaryAction.count})`
      : primaryAction.label;

  // Per-row affordances shared by the staging-area sections. getRowActions
  // gates which inline buttons render per area, so passing the full set to every
  // section is safe (e.g. onUnstageFile is a no-op for an unstaged row).
  const rowActionProps = {
    onStageFile: (path: string) => void runStage([path]),
    onUnstageFile: (path: string) => void runUnstage([path]),
    onRequestDiscardFile,
    onCopyPath,
    onOpenExternalEditor,
    isPrimaryEnv,
  };

  return (
    <DiffPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <div className="relative">
          <Textarea
            value={draft.message}
            onChange={(event) => setMessage(threadRef, event.target.value)}
            placeholder="Message (leave empty to auto-generate)"
            size="sm"
            aria-label="Commit message"
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => (generateAction.isPending ? cancelGenerate() : void onGenerate())}
            disabled={files.length === 0 && !generateAction.isPending}
            aria-label={
              generateAction.isPending ? "Stop generating" : "Generate commit message with AI"
            }
            title={generateAction.isPending ? "Stop" : "Generate commit message with AI"}
            className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {generateAction.isPending ? (
              <SquareIcon className="size-3.5" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
          </button>
        </div>

        <div className="flex items-center gap-1">
          {hasAreas ? (
            <>
              <Button
                className="flex-1"
                size="sm"
                disabled={scPrimaryDisabled}
                onClick={onScPrimaryAction}
                {...(primaryAction.hint ? { title: primaryAction.hint } : {})}
              >
                {isBusy ? <Spinner className="size-3.5" aria-hidden /> : null}
                {scPrimaryLabel}
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button aria-label="Source control actions" size="icon-xs" variant="outline" />
                  }
                  disabled={isBusy}
                >
                  <ChevronDownIcon className="size-4" aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">
                  {scMenuItems.map((item, index) => (
                    <Fragment key={item.id}>
                      {index > 0 && scMenuItems[index - 1]?.group !== item.group ? (
                        <MenuSeparator />
                      ) : null}
                      <MenuItem
                        disabled={item.disabled}
                        {...(item.reason ? { title: item.reason } : {})}
                        onClick={() => onScMenuItem(item)}
                      >
                        {item.group === "commit" ? (
                          <GitCommitIcon />
                        ) : item.id === "pull" ? (
                          <DownloadIcon />
                        ) : item.id === "push" || item.id === "publish" ? (
                          <CloudUploadIcon />
                        ) : (
                          <presentation.Icon />
                        )}
                        {item.label}
                      </MenuItem>
                    </Fragment>
                  ))}
                </MenuPopup>
              </Menu>
            </>
          ) : (
            <>
              <Button
                className="flex-1"
                size="sm"
                disabled={primaryDisabled}
                onClick={onPrimaryAction}
              >
                {isBusy ? <Spinner className="size-3.5" aria-hidden /> : null}
                {quickAction.label}
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button aria-label="Source control actions" size="icon-xs" variant="outline" />
                  }
                  disabled={isBusy}
                >
                  <ChevronDownIcon className="size-4" aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">
                  {menuItems.map((item) => (
                    <MenuItem
                      key={item.id}
                      disabled={
                        item.disabled ||
                        (item.dialogAction === "commit" &&
                          (hasAreas ? groups.staged.length === 0 : files.length === 0))
                      }
                      onClick={() => {
                        if (item.kind === "open_pr") return openPr();
                        if (item.dialogAction) return void runGitAction(item.dialogAction);
                      }}
                    >
                      {item.icon === "commit" ? (
                        <GitCommitIcon />
                      ) : item.icon === "push" ? (
                        <CloudUploadIcon />
                      ) : (
                        <presentation.Icon />
                      )}
                      {item.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1 rounded-md border border-border/60">
          {statusQuery.isPending && !status ? (
            <p className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Spinner className="size-3.5" aria-hidden /> Loading changes…
            </p>
          ) : files.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">No changes</p>
          ) : !hasAreas ? (
            // Legacy server (no staging areas): one flat list of all changes.
            // No stage/unstage RPCs exist here, so no per-row checkbox renders.
            <SourceControlSection
              title="Changes"
              files={files}
              onToggle={LEGACY_NOOP_TOGGLE}
              onOpenFile={openFileInDiff}
              disabled={isBusy}
            />
          ) : (
            <>
              <SourceControlSection
                title="Staged Changes"
                files={groups.staged}
                checked={isFileStaged}
                onToggle={onToggleFile}
                onOpenFile={openFileInDiff}
                primaryAction={{
                  icon: "unstage",
                  label: "Unstage all",
                  onClick: () => void runUnstage(groups.staged.map((file) => file.path)),
                }}
                disabled={isBusy}
                {...rowActionProps}
              />
              <SourceControlSection
                title="Changes"
                files={groups.unstaged}
                checked={isFileStaged}
                onToggle={onToggleFile}
                onOpenFile={openFileInDiff}
                primaryAction={{
                  icon: "stage",
                  label: "Stage all",
                  onClick: () => void runStage(groups.unstaged.map((file) => file.path)),
                }}
                onDiscard={() =>
                  setPendingDiscard({
                    kind: "bulk",
                    paths: groups.unstaged.map((file) => file.path),
                    variant: "discard",
                  })
                }
                disabled={isBusy}
                {...rowActionProps}
              />
              <SourceControlSection
                title="Untracked Files"
                files={groups.untracked}
                checked={isFileStaged}
                onToggle={onToggleFile}
                onOpenFile={openFileInDiff}
                primaryAction={{
                  icon: "stage",
                  label: "Stage all",
                  onClick: () => void runStage(groups.untracked.map((file) => file.path)),
                }}
                onDiscard={() =>
                  setPendingDiscard({
                    kind: "bulk",
                    paths: groups.untracked.map((file) => file.path),
                    variant: "delete-untracked",
                  })
                }
                discardVariant="delete-untracked"
                disabled={isBusy}
                {...rowActionProps}
              />
            </>
          )}
        </ScrollArea>

        {summary.totalCount > 0 ? (
          <div className={cn("flex justify-end px-1 font-mono text-[11px]")}>
            <span className="text-success">+{summary.insertions}</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-destructive">-{summary.deletions}</span>
          </div>
        ) : null}
      </div>

      <Dialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => !open && setPendingConfirm(null)}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingConfirmCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingConfirmCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const action = pendingConfirm?.action;
                setPendingConfirm(null);
                if (action) void runGitAction(action, { skipConfirm: true });
              }}
            >
              {pendingConfirmCopy?.continueLabel ?? "Continue"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => !open && setPendingDiscard(null)}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pendingDiscardCopy?.title ?? "Discard changes?"}</DialogTitle>
            <DialogDescription>{pendingDiscardCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDiscard(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              {...(pendingDiscardCopy?.destructive ? { variant: "destructive" as const } : {})}
              onClick={() => {
                const paths = pendingDiscard ? discardPathsOf(pendingDiscard) : null;
                setPendingDiscard(null);
                if (paths) void runDiscard(paths);
              }}
            >
              {pendingDiscardCopy?.confirmLabel ?? "Discard"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <SourceControlCommits
        threadRef={threadRef}
        gitCwd={gitCwd}
        nowMs={nowMs}
        reloadToken={commitSignal}
      />
    </DiffPanelShell>
  );
}
