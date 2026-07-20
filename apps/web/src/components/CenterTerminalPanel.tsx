import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t4code/contracts";
import { resolveTerminalSessionLabel } from "@t4code/shared/terminalLabels";
import { useMemo } from "react";

import type { TerminalContextSelection } from "~/lib/terminalContext";
import type { CenterSurface } from "~/centerPanelStore";
import { useKnownTerminalSessions } from "~/state/terminalSessions";

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

interface CenterTerminalPanelProps {
  /** The HOST thread ref — center terminals reuse the host thread's attach layer. */
  threadRef: ScopedThreadRef;
  surface: Extract<CenterSurface, { kind: "terminal" }>;
  launchContext: {
    readonly cwd: string;
    readonly worktreePath: string | null;
    readonly runtimeEnv: Record<string, string>;
  } | null;
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
 * out of scope for v1, so a single-terminal group is synthesized and those
 * unsupported controls are omitted.
 */
export function CenterTerminalPanel({
  threadRef,
  surface,
  launchContext,
  keybindings,
  focusRequestId,
  onAddTerminalContext,
  onClose,
}: CenterTerminalPanelProps) {
  const { terminalId, command, label } = surface;
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const activeSummary =
    knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
      .summary ?? null;
  const terminalCommandsById = useMemo(
    () => (command ? new Map([[terminalId, command]]) : undefined),
    [command, terminalId],
  );
  const terminalLabelsById = useMemo(
    () => new Map([[terminalId, label ?? resolveTerminalSessionLabel(terminalId, activeSummary)]]),
    [activeSummary, label, terminalId],
  );

  if (launchContext === null) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={launchContext.cwd}
      worktreePath={launchContext.worktreePath}
      runtimeEnv={launchContext.runtimeEnv}
      height={0}
      terminalIds={[terminalId]}
      activeTerminalId={terminalId}
      terminalGroups={[{ id: `terminal:${terminalId}`, terminalIds: [terminalId] }]}
      activeTerminalGroupId={`terminal:${terminalId}`}
      focusRequestId={focusRequestId}
      onActiveTerminalChange={noop}
      onCloseTerminal={onClose}
      onHeightChange={noop}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      {...(terminalCommandsById ? { terminalCommandsById } : {})}
      keybindings={keybindings}
    />
  );
}
