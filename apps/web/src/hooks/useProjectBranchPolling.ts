import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";

const ACTIVE_PROJECT_POLL_INTERVAL_MS = 3_000;
const BACKGROUND_PROJECT_POLL_INTERVAL_MS = 30_000;

export interface ProjectBranchPollingProject {
  /** Stable key for this project, e.g. `scopedProjectKey(environmentId, projectId)`. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface UseProjectBranchPollingResult {
  /** Live checkout branch by project key. Absent key = not yet polled. */
  readonly branchByProjectKey: Map<string, string | null>;
}

/**
 * Keeps the sidebar's primary-row "current branch" label live for the
 * project checkout (as opposed to `thread.branch`, which is static). Mirrors
 * Orca's 3s visibility-aware branch poll (research-orca-project-model.md
 * §1): the ACTIVE project (the one owning the currently routed thread) is
 * polled every 3s while the tab is visible; `vcs.status` is a push
 * subscription so we read its data reactively and use `vcs.refreshStatus`
 * (see `GitActionsControl.tsx`'s identical pattern) to force freshness on
 * each tick.
 *
 * TODO(orca-port): background projects (the "other visible projects poll
 * every 30s" half of pinned interface 5) are refreshed on the same cadence
 * via `refreshStatus`, but since a dynamic-length list of projects can't
 * each own a `useEnvironmentQuery` subscription from a single hook without
 * breaking the rules of hooks, their resulting branch is not yet read back
 * into `branchByProjectKey` here — only the active project's branch is
 * populated today. Full parity needs either a per-row poller
 * (`<ProjectBranchPoller />`) mounted per project row, or a lower-level
 * imperative registry read; revisit before wiring "on expand" polling.
 */
export function useProjectBranchPolling(input: {
  readonly projects: ReadonlyArray<ProjectBranchPollingProject>;
  readonly activeProjectKey: string | null;
}): UseProjectBranchPollingResult {
  const { activeProjectKey, projects } = input;
  const activeProject = projects.find((project) => project.key === activeProjectKey) ?? null;

  const [branchByProjectKey, setBranchByProjectKey] = useState<Map<string, string | null>>(
    () => new Map(),
  );

  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });

  const activeStatusQuery = useEnvironmentQuery(
    activeProject
      ? vcsEnvironment.status({
          environmentId: activeProject.environmentId,
          input: { cwd: activeProject.workspaceRoot },
        })
      : null,
  );

  useEffect(() => {
    if (!activeProject) return;
    const branch = activeStatusQuery.data?.refName ?? null;
    setBranchByProjectKey((current) => {
      if (current.get(activeProject.key) === branch) return current;
      const next = new Map(current);
      next.set(activeProject.key, branch);
      return next;
    });
  }, [activeProject, activeStatusQuery.data]);

  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  useEffect(() => {
    if (!activeProject) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const current = activeProjectRef.current;
      if (!current) return;
      void refreshStatus({
        environmentId: current.environmentId,
        input: { cwd: current.workspaceRoot },
      });
    };
    const interval = window.setInterval(tick, ACTIVE_PROJECT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interval reads latest project via ref
  }, [activeProject?.key, refreshStatus]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      for (const project of projectsRef.current) {
        if (project.key === activeProjectRef.current?.key) continue; // already polled above
        void refreshStatus({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        });
      }
    };
    const interval = window.setInterval(tick, BACKGROUND_PROJECT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshStatus]);

  return { branchByProjectKey };
}
