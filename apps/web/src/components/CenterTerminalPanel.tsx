import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t4code/contracts";
import { scopeProjectRef } from "@t4code/client-runtime/environment";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t4code/shared/projectScripts";
import { resolveTerminalSessionLabel } from "@t4code/shared/terminalLabels";
import { useMemo } from "react";

import type { TerminalContextSelection } from "~/lib/terminalContext";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useProject, useThread } from "~/state/entities";
import { useKnownTerminalSessions } from "~/state/terminalSessions";

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

interface CenterTerminalPanelProps {
  /** The HOST thread ref — center terminals reuse the host thread's attach layer. */
  threadRef: ScopedThreadRef;
  terminalId: string;
  keybindings: ResolvedKeybindingsConfig;
  focusRequestId: number;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  /** Invoked when the terminal is closed from within its own chrome. */
  onClose: () => void;
}

const noop = () => undefined;

/**
 * Thin center-area host for a single terminal, tied to the host thread.
 *
 * The xterm view + attach layer already work outside the bottom drawer via
 * `<ThreadTerminalDrawer mode="panel">` (see research-ui.md §4). This resolves
 * cwd/worktree/runtimeEnv from the host thread's project — the same derivation
 * as ChatView's PersistentThreadTerminalPanel, which is kept private to that
 * file to avoid a ChatView↔CenterTerminalPanel import cycle. Splits/groups are
 * out of scope for v1, so a single-terminal group is synthesized and the
 * split/new handlers are inert.
 */
export function CenterTerminalPanel({
  threadRef,
  terminalId,
  keybindings,
  focusRequestId,
  onAddTerminalContext,
  onClose,
}: CenterTerminalPanelProps) {
  const serverThread = useThread(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
      .summary ?? null;
  const worktreePath = activeSummary?.worktreePath ?? threadWorktreePath;
  const cwd = useMemo(
    () =>
      activeSummary?.cwd ??
      (project
        ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath })
        : null),
    [activeSummary?.cwd, project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath })
        : {},
    [project, worktreePath],
  );
  const terminalLabelsById = useMemo(
    () => new Map([[terminalId, resolveTerminalSessionLabel(terminalId, activeSummary)]]),
    [terminalId, activeSummary],
  );

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={[terminalId]}
      activeTerminalId={terminalId}
      terminalGroups={[{ id: `terminal:${terminalId}`, terminalIds: [terminalId] }]}
      activeTerminalGroupId={`terminal:${terminalId}`}
      focusRequestId={focusRequestId}
      onSplitTerminal={noop}
      onSplitTerminalVertical={noop}
      onNewTerminal={noop}
      onActiveTerminalChange={noop}
      onCloseTerminal={onClose}
      onHeightChange={noop}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      keybindings={keybindings}
    />
  );
}
