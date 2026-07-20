/**
 * Center-panel lifecycle actions (Wave C).
 *
 * A chat panel is a sibling thread (kind:"panel") that copies the host thread's
 * project/worktree/branch so it shares the same workspace. Opening one creates
 * the thread then registers a center surface; closing one removes the surface
 * and deletes the thread (fire-and-forget, toast on failure). Terminal panels
 * just register a surface — the terminal is attach-created lazily by the view.
 *
 * The multi-close variants (others/to-right/all) delete every chat panel thread
 * they drop so panel threads never leak (they are hidden from the sidebar and
 * would otherwise linger until the project is deleted).
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t4code/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t4code/contracts";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
} from "@t4code/contracts";
import { createModelSelection } from "@t4code/shared/model";
import { nextTerminalId } from "@t4code/shared/terminalLabels";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  HOST_SURFACE_ID,
  selectThreadCenterPanelState,
  useCenterPanelStore,
  type CenterSurface,
  type OpenTerminalPanelOptions,
} from "~/centerPanelStore";
import { newThreadId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

export interface CreateChatPanelInput {
  /** Host thread ref — keys the center-panel store and provides the environment. */
  hostRef: ScopedThreadRef;
  /** Copied from the host thread so the panel shares its workspace. */
  projectId: ProjectId;
  worktreePath?: string | null;
  branch?: string | null;
  /** Chosen provider instance + model for the new panel thread. */
  instanceId: string;
  model?: string;
  /** Display label used for the thread title and the tab. */
  providerLabel: string;
}

export interface CenterPanelActions {
  createChatPanel: (input: CreateChatPanelInput) => Promise<ThreadId | null>;
  openTerminalPanel: (
    hostRef: ScopedThreadRef,
    existingTerminalIds: ReadonlyArray<string>,
    options?: OpenTerminalPanelOptions,
  ) => string;
  activateSurface: (hostRef: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (hostRef: ScopedThreadRef, surface: CenterSurface) => void;
  closeOtherSurfaces: (hostRef: ScopedThreadRef, surface: CenterSurface) => void;
  closeSurfacesToRight: (hostRef: ScopedThreadRef, surface: CenterSurface) => void;
  closeAllSurfaces: (hostRef: ScopedThreadRef) => void;
}

export function useCenterPanelActions(): CenterPanelActions {
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });

  const deletePanelThread = useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) => {
      void deleteThread({ environmentId, input: { threadId } }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to close chat panel",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [deleteThread],
  );

  const createChatPanel = useCallback(
    async (input: CreateChatPanelInput): Promise<ThreadId | null> => {
      const { hostRef, projectId, worktreePath, branch, instanceId, model, providerLabel } = input;
      const environmentId = hostRef.environmentId;
      const threadId = newThreadId();
      const modelSelection = createModelSelection(
        ProviderInstanceId.make(instanceId),
        model || DEFAULT_MODEL,
      );
      const result = await createThread({
        environmentId,
        input: {
          threadId,
          projectId,
          title: `Panel — ${providerLabel}`,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          kind: "panel",
          // branch/worktreePath are required-but-nullable; copy the host's when
          // set (empty string coerces to null to satisfy TrimmedNonEmptyString).
          branch: branch || null,
          worktreePath: worktreePath || null,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to open chat panel",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return null;
      }
      useCenterPanelStore.getState().openChatPanel(hostRef, threadId, providerLabel);
      return threadId;
    },
    [createThread],
  );

  const openTerminalPanel = useCallback(
    (
      hostRef: ScopedThreadRef,
      existingTerminalIds: ReadonlyArray<string>,
      options?: OpenTerminalPanelOptions,
    ): string => {
      // term-N ids get the human "Terminal N" tab label everywhere; the caller
      // passes every id the host thread already uses (drawer + center panels)
      // so the id never aliases an existing attach-created terminal.
      const terminalId = nextTerminalId(existingTerminalIds);
      useCenterPanelStore.getState().openTerminalPanel(hostRef, terminalId, options);
      return terminalId;
    },
    [],
  );

  const activateSurface = useCallback((hostRef: ScopedThreadRef, surfaceId: string) => {
    useCenterPanelStore.getState().activateSurface(hostRef, surfaceId);
  }, []);

  const closeSurface = useCallback(
    (hostRef: ScopedThreadRef, surface: CenterSurface) => {
      useCenterPanelStore.getState().closeSurface(hostRef, surface.id);
      if (surface.kind === "chat") deletePanelThread(hostRef.environmentId, surface.threadId);
    },
    [deletePanelThread],
  );

  const closeOtherSurfaces = useCallback(
    (hostRef: ScopedThreadRef, surface: CenterSurface) => {
      const store = useCenterPanelStore.getState();
      const current = selectThreadCenterPanelState(store.byThreadKey, hostRef);
      const keptIds = new Set<string>([HOST_SURFACE_ID, surface.id]);
      for (const entry of current.surfaces) {
        if (!keptIds.has(entry.id) && entry.kind === "chat") {
          deletePanelThread(hostRef.environmentId, entry.threadId);
        }
      }
      store.closeOtherSurfaces(hostRef, surface.id);
    },
    [deletePanelThread],
  );

  const closeSurfacesToRight = useCallback(
    (hostRef: ScopedThreadRef, surface: CenterSurface) => {
      const store = useCenterPanelStore.getState();
      const current = selectThreadCenterPanelState(store.byThreadKey, hostRef);
      const index = current.surfaces.findIndex((entry) => entry.id === surface.id);
      if (index >= 0) {
        for (const entry of current.surfaces.slice(index + 1)) {
          if (entry.kind === "chat") deletePanelThread(hostRef.environmentId, entry.threadId);
        }
      }
      store.closeSurfacesToRight(hostRef, surface.id);
    },
    [deletePanelThread],
  );

  const closeAllSurfaces = useCallback(
    (hostRef: ScopedThreadRef) => {
      const store = useCenterPanelStore.getState();
      const current = selectThreadCenterPanelState(store.byThreadKey, hostRef);
      for (const entry of current.surfaces) {
        if (entry.kind === "chat") deletePanelThread(hostRef.environmentId, entry.threadId);
      }
      store.closeAllSurfaces(hostRef);
    },
    [deletePanelThread],
  );

  return {
    createChatPanel,
    openTerminalPanel,
    activateSurface,
    closeSurface,
    closeOtherSurfaces,
    closeSurfacesToRight,
    closeAllSurfaces,
  };
}
