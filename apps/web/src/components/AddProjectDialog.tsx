"use client";

// Orca-parity Add Project dialog (.superpowers/orca-port/00-port-plan.md §W2):
// browse-to-repo, folder-of-repos multi-import, clone-from-URL (vcs.clone), and
// create-new-project. Folder-of-repos child scanning is bounded (first
// CHILD_SCAN_LIMIT entries) to avoid unbounded fan-out of filesystem.browse calls.

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_MODEL,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseParentPath,
  inferProjectTitleFromPath,
} from "~/lib/projectPaths";
import { cn, newProjectId } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { filesystemEnvironment } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import {
  detectFolderOfRepos,
  hasGitEntry,
  type BrowseEntryLike,
  type ChildRepoScan,
} from "./CreateWorktreeDialog.logic";
import { Button } from "./ui/button";
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
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface AddProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const DEFAULT_BROWSE_PATH = "~";
const CHILD_SCAN_LIMIT = 25;

function ChildRepoScanRow({
  environmentId,
  entry,
  selected,
  onToggle,
  onScanned,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: BrowseEntryLike;
  readonly selected: boolean;
  readonly onToggle: (fullPath: string) => void;
  readonly onScanned: (scan: ChildRepoScan) => void;
}) {
  const childBrowse = useEnvironmentQuery(
    filesystemEnvironment.browse({
      environmentId,
      input: { partialPath: entry.fullPath },
    }),
  );
  const hasGit = childBrowse.data ? hasGitEntry(childBrowse.data.entries) : null;

  useEffect(() => {
    if (hasGit === null) return;
    onScanned({ name: entry.name, fullPath: entry.fullPath, hasGit });
  }, [hasGit, entry.fullPath, entry.name]);

  if (childBrowse.isPending || hasGit === null) {
    return <li className="text-muted-foreground px-3 py-1 text-xs">Scanning {entry.name}...</li>;
  }
  if (!hasGit) return null;

  return (
    <li>
      <label className="hover:bg-accent flex items-center gap-2 px-3 py-1.5 text-sm">
        <input type="checkbox" checked={selected} onChange={() => onToggle(entry.fullPath)} />
        {entry.name}
      </label>
    </li>
  );
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId: EnvironmentId =
    primaryEnvironment?.environmentId ?? EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);

  const [path, setPath] = useState(DEFAULT_BROWSE_PATH);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedChildPaths, setSelectedChildPaths] = useState<ReadonlySet<string>>(new Set());
  const [childScans, setChildScans] = useState<ReadonlyMap<string, ChildRepoScan>>(new Map());

  useEffect(() => {
    if (!open) return;
    setPath(DEFAULT_BROWSE_PATH);
    setSelectedChildPaths(new Set());
    setChildScans(new Map());
  }, [open]);

  // Reset child-repo scan state whenever the browsed directory changes.
  useEffect(() => {
    setSelectedChildPaths(new Set());
    setChildScans(new Map());
  }, [path]);

  const browseQuery = useEnvironmentQuery(
    open ? filesystemEnvironment.browse({ environmentId, input: { partialPath: path } }) : null,
  );
  const entries: ReadonlyArray<BrowseEntryLike> = browseQuery.data?.entries ?? [];
  const selectedIsRepo = hasGitEntry(entries);
  const childScanCandidates = useMemo(
    () => (selectedIsRepo ? [] : entries.slice(0, CHILD_SCAN_LIMIT)),
    [entries, selectedIsRepo],
  );

  const handleChildScanned = useCallback((scan: ChildRepoScan) => {
    setChildScans((current) => {
      const next = new Map(current);
      next.set(scan.fullPath, scan);
      return next;
    });
  }, []);

  const folderOfRepos = useMemo(
    () => detectFolderOfRepos(entries, Array.from(childScans.values())),
    [entries, childScans],
  );

  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const cloneRepo = useAtomCommand(vcsEnvironment.clone, { reportFailure: false });
  const [cloneUrl, setCloneUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);

  const runCreateProject = useCallback(
    async (workspaceRoot: string) => {
      const result = await createProject({
        environmentId,
        input: {
          projectId: newProjectId(),
          title: inferProjectTitleFromPath(workspaceRoot),
          workspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to add project at ${workspaceRoot}`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      }
      return true;
    },
    [createProject, environmentId],
  );

  const handleAddCurrentFolder = useCallback(async () => {
    setIsSubmitting(true);
    try {
      const ok = await runCreateProject(path);
      if (ok) onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [path, runCreateProject, onOpenChange]);

  const handleClone = useCallback(async () => {
    const url = cloneUrl.trim();
    if (url.length === 0) return;
    setIsCloning(true);
    try {
      const result = await cloneRepo({
        environmentId,
        input: { url, parentDir: path },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Clone failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      const ok = await runCreateProject(result.value.path);
      if (ok) onOpenChange(false);
    } finally {
      setIsCloning(false);
    }
  }, [cloneUrl, cloneRepo, environmentId, path, runCreateProject, onOpenChange]);

  const handleImportSelectedChildren = useCallback(async () => {
    setIsSubmitting(true);
    try {
      let succeeded = 0;
      for (const childPath of selectedChildPaths) {
        const ok = await runCreateProject(childPath);
        if (ok) succeeded += 1;
      }
      if (succeeded > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Added ${succeeded} project${succeeded === 1 ? "" : "s"}`,
          }),
        );
      }
      if (succeeded === selectedChildPaths.size) {
        onOpenChange(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedChildPaths, runCreateProject, onOpenChange]);

  const toggleChildSelected = useCallback((fullPath: string) => {
    setSelectedChildPaths((current) => {
      const next = new Set(current);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Browse to a local repository, import a folder of repositories, or clone from a URL.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex items-center gap-1.5 text-sm">
            <MonitorIcon className="size-3.5" />
            <span className="font-medium">Local</span>
            <span className="text-muted-foreground text-xs">This device</span>
          </div>

          <div className="space-y-1.5">
            <span className="text-foreground text-xs font-medium">Folder</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canNavigateUp(path)}
                onClick={() => setPath((current) => getBrowseParentPath(current) ?? current)}
              >
                Up
              </Button>
              <Input value={path} onChange={(event) => setPath(event.target.value)} />
            </div>
            <div className="border-border/70 max-h-56 overflow-y-auto rounded-lg border">
              {entries.length === 0 ? (
                <p className="text-muted-foreground px-3 py-2 text-xs">
                  {browseQuery.isPending ? "Loading..." : "No entries."}
                </p>
              ) : (
                entries
                  .filter((entry) => entry.name !== ".git")
                  .map((entry) => (
                    <button
                      key={entry.fullPath}
                      type="button"
                      className={cn(
                        "hover:bg-accent flex w-full items-center px-3 py-1.5 text-left text-sm",
                      )}
                      onClick={() => setPath(appendBrowsePathSegment(path, entry.name))}
                    >
                      {entry.name}
                    </button>
                  ))
              )}
            </div>
            {selectedIsRepo ? (
              <p className="text-muted-foreground text-xs">This folder is a git repository.</p>
            ) : null}
          </div>

          {!selectedIsRepo && childScanCandidates.length > 0 ? (
            <div className="space-y-1.5">
              <span className="text-foreground text-xs font-medium">
                Repositories found in this folder
              </span>
              <ul className="border-border/70 max-h-48 overflow-y-auto rounded-lg border">
                {childScanCandidates.map((entry) => (
                  <ChildRepoScanRow
                    key={entry.fullPath}
                    environmentId={environmentId}
                    entry={entry}
                    selected={selectedChildPaths.has(entry.fullPath)}
                    onToggle={toggleChildSelected}
                    onScanned={handleChildScanned}
                  />
                ))}
              </ul>
              <Button
                type="button"
                size="sm"
                disabled={selectedChildPaths.size === 0 || isSubmitting}
                onClick={() => void handleImportSelectedChildren()}
              >
                Import {selectedChildPaths.size || ""} selected
              </Button>
              {!folderOfRepos.isFolderOfRepos && childScans.size >= childScanCandidates.length ? (
                <p className="text-muted-foreground text-xs">
                  No repositories found among the scanned folders.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <span className="text-foreground text-xs font-medium">Clone from URL</span>
            <div className="flex gap-2">
              <Input
                placeholder="https://github.com/org/repo.git"
                value={cloneUrl}
                onChange={(event) => setCloneUrl(event.target.value)}
                disabled={isCloning}
              />
              <Button
                type="button"
                variant="outline"
                disabled={cloneUrl.trim().length === 0 || isCloning}
                onClick={() => void handleClone()}
              >
                {isCloning ? "Cloning..." : "Clone"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">Clones into the folder shown above.</p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleAddCurrentFolder()}
          >
            {isSubmitting
              ? "Adding..."
              : selectedIsRepo
                ? "Add project"
                : "Create new project here"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
