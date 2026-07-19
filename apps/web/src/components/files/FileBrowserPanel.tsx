import { DEFAULT_MODEL, ProviderInstanceId } from "@t4code/contracts";
import type { EditorId, EnvironmentId, ProjectEntry, ScopedThreadRef } from "@t4code/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t4code/client-runtime/state/runtime";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { FolderClosed, FolderOpen, RefreshCw, Search } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { usePreferredEditor } from "~/editorPreferences";
import { useTheme } from "~/hooks/useTheme";
import { inferProjectTitleFromPath } from "~/lib/projectPaths";
import { cn, newProjectId } from "~/lib/utils";
import { T4CODE_PIERRE_ICONS } from "~/pierre-icons";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { stackedThreadToast, toastManager } from "../ui/toast";
import FileEntryDialog, { type FileEntryDialogRequest } from "./FileEntryDialog";
import type { FilePathMutationLease } from "./filePathMutationLease";
import { isMarkdownPreviewFile } from "./filePreviewMode";
import FileTreeContextMenu, { type FileTreeMenuActions } from "./FileTreeContextMenu";
import {
  buildFileTreeMenuModel,
  entryName,
  type FileTreeEntryKind,
  joinRelativePath,
  joinWorkspacePath,
  parentRelativePath,
  stripTrailingSlash,
} from "./FileTreeContextMenu.logic";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  threadRef: ScopedThreadRef;
  availableEditors: ReadonlyArray<EditorId>;
  onOpenFile: (relativePath: string) => void;
  /**
   * Acquires a per-path editing-session lease before rename/delete/duplicate
   * filesystem operations. Returning null prevents the mutation.
   */
  onBeginPathMutation?: (relativePath: string) => Promise<FilePathMutationLease | null>;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

interface CollapsibleTreeItem {
  collapse?: () => void;
  isDirectory: () => boolean;
}

interface CollapsibleTreeModel {
  getItem: (path: string) => CollapsibleTreeItem | null;
}

export function expandedDirectoryTreePaths(entries: ReadonlyArray<ProjectEntry>): string[] {
  return entries.filter((entry) => entry.kind === "directory").map(treePath);
}

export function collapseDirectoryTreePaths(
  model: CollapsibleTreeModel,
  directoryTreePaths: ReadonlyArray<string>,
): void {
  for (const path of directoryTreePaths) {
    const item = model.getItem(path);
    if (item?.isDirectory()) item.collapse?.();
  }
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  threadRef,
  availableEditors,
  onOpenFile,
  onBeginPathMutation,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const expandedTreePaths = useMemo(() => expandedDirectoryTreePaths(entries), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimaryEnv = primaryEnvironmentId === environmentId;
  const hasWorkspaceRoot = cwd.length > 0;

  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createEntry = useAtomCommand(projectEnvironment.createEntry, { reportFailure: false });
  const renameEntry = useAtomCommand(projectEnvironment.renameEntry, { reportFailure: false });
  const deleteEntry = useAtomCommand(projectEnvironment.deleteEntry, { reportFailure: false });
  const duplicateEntry = useAtomCommand(projectEnvironment.duplicateEntry, {
    reportFailure: false,
  });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "open in editor");

  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [preferredEditor] = usePreferredEditor(availableEditors);

  const remapFileSurfaces = useRightPanelStore((state) => state.remapFileSurfaces);
  const closeFileSurfacesUnder = useRightPanelStore((state) => state.closeFileSurfacesUnder);

  const [dialogRequest, setDialogRequest] = useState<FileEntryDialogRequest | null>(null);
  // Right-click on empty tree space: Pierre only surfaces row menus, so a background menu is
  // opened from the container's contextmenu event, anchored to the cursor point.
  const [backgroundMenu, setBackgroundMenu] = useState<{ x: number; y: number } | null>(null);

  const copyText = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to copy to clipboard",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, []);

  // The projects.* mutations fail with a structured `failure` code. The outward-symlink refusal is a
  // deliberate safety block (Agent A), so it gets a plain explanation; everything else shows the
  // server message.
  const showMutationError = useCallback((error: unknown, title: string) => {
    const failure =
      typeof error === "object" && error !== null && "failure" in error
        ? (error as { failure?: unknown }).failure
        : undefined;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description:
          failure === "resolved_path_outside_root"
            ? "Can't operate on a symlink that points outside the workspace."
            : error instanceof Error
              ? error.message
              : "An error occurred.",
      }),
    );
  }, []);

  const addAsProject = useCallback(
    (workspaceRoot: string) => {
      void (async () => {
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
            showMutationError(
              squashAtomCommandFailure(result),
              `Failed to add project at ${workspaceRoot}`,
            );
          }
        }
      })();
    },
    [createProject, environmentId, showMutationError],
  );

  const createChildEntry = useCallback(
    (targetDir: string, kind: "file" | "directory") => {
      const isFile = kind === "file";
      setDialogRequest({
        mode: "prompt",
        title: isFile ? "New File" : "New Folder",
        ...(targetDir ? { description: `In ${targetDir}` } : {}),
        label: "Name",
        initialValue: "",
        confirmLabel: "Create",
        onSubmit: (name) => {
          void (async () => {
            const relativePath = joinRelativePath(targetDir, name);
            const result = await createEntry({ environmentId, input: { cwd, relativePath, kind } });
            if (result._tag === "Failure") {
              if (!isAtomCommandInterrupted(result)) {
                showMutationError(
                  squashAtomCommandFailure(result),
                  `Failed to create ${isFile ? "file" : "folder"} "${name}"`,
                );
              }
              return;
            }
            entriesQuery.refresh();
            if (isFile) onOpenFile(result.value.relativePath);
          })();
        },
      });
    },
    [createEntry, cwd, entriesQuery, environmentId, onOpenFile, showMutationError],
  );

  const renameEntryAt = useCallback(
    (relativePath: string) => {
      const currentName = entryName(relativePath);
      setDialogRequest({
        mode: "prompt",
        title: "Rename",
        label: "New name",
        initialValue: currentName,
        confirmLabel: "Rename",
        selectBasename: true,
        onSubmit: (name) => {
          if (name === currentName) return;
          const toRelativePath = joinRelativePath(parentRelativePath(relativePath), name);
          void (async () => {
            let lease: FilePathMutationLease | null | undefined;
            try {
              lease = await onBeginPathMutation?.(relativePath);
              if (onBeginPathMutation && !lease) return;
              const result = await renameEntry({
                environmentId,
                input: { cwd, fromRelativePath: relativePath, toRelativePath },
              });
              if (result._tag === "Failure") {
                if (!isAtomCommandInterrupted(result)) {
                  showMutationError(
                    squashAtomCommandFailure(result),
                    `Failed to rename "${currentName}"`,
                  );
                }
                return;
              }
              lease?.commitRename(result.value.relativePath);
              remapFileSurfaces(threadRef, relativePath, result.value.relativePath);
              entriesQuery.refresh();
            } catch (error) {
              showMutationError(error, `Failed to rename "${currentName}"`);
            } finally {
              lease?.release();
            }
          })();
        },
      });
    },
    [
      cwd,
      entriesQuery,
      environmentId,
      onBeginPathMutation,
      remapFileSurfaces,
      renameEntry,
      showMutationError,
      threadRef,
    ],
  );

  const deleteEntryAt = useCallback(
    (relativePath: string, kind: FileTreeEntryKind) => {
      const name = entryName(relativePath);
      const isDirectory = kind === "directory";
      setDialogRequest({
        mode: "confirm",
        title: `Delete ${isDirectory ? "folder" : "file"}`,
        description: isDirectory
          ? `Delete "${name}" and everything inside it? This can't be undone.`
          : `Delete "${name}"? This can't be undone.`,
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: () => {
          void (async () => {
            let lease: FilePathMutationLease | null | undefined;
            try {
              lease = await onBeginPathMutation?.(relativePath);
              if (onBeginPathMutation && !lease) return;
              const result = await deleteEntry({ environmentId, input: { cwd, relativePath } });
              if (result._tag === "Failure") {
                if (!isAtomCommandInterrupted(result)) {
                  showMutationError(squashAtomCommandFailure(result), `Failed to delete "${name}"`);
                }
                return;
              }
              lease?.commitDelete();
              closeFileSurfacesUnder(threadRef, relativePath);
              entriesQuery.refresh();
            } catch (error) {
              showMutationError(error, `Failed to delete "${name}"`);
            } finally {
              lease?.release();
            }
          })();
        },
      });
    },
    [
      closeFileSurfacesUnder,
      cwd,
      deleteEntry,
      entriesQuery,
      environmentId,
      onBeginPathMutation,
      showMutationError,
      threadRef,
    ],
  );

  const duplicateEntryAt = useCallback(
    (relativePath: string) => {
      void (async () => {
        let lease: FilePathMutationLease | null | undefined;
        try {
          lease = await onBeginPathMutation?.(relativePath);
          if (onBeginPathMutation && !lease) return;
          const result = await duplicateEntry({ environmentId, input: { cwd, relativePath } });
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              showMutationError(
                squashAtomCommandFailure(result),
                `Failed to duplicate "${entryName(relativePath)}"`,
              );
            }
            return;
          }
          entriesQuery.refresh();
          onOpenFile(result.value.relativePath);
        } catch (error) {
          showMutationError(error, `Failed to duplicate "${entryName(relativePath)}"`);
        } finally {
          lease?.release();
        }
      })();
    },
    [
      cwd,
      duplicateEntry,
      entriesQuery,
      environmentId,
      onBeginPathMutation,
      onOpenFile,
      showMutationError,
    ],
  );

  const openExternalEditor = useCallback(
    (relativePath: string) => {
      if (!preferredEditor) return;
      void openInEditor({
        environmentId,
        input: { cwd: joinWorkspacePath(cwd, relativePath), editor: preferredEditor },
      });
    },
    [cwd, environmentId, openInEditor, preferredEditor],
  );

  const openPreviewFor = useCallback(
    (relativePath: string) => {
      if (!environmentHttpBaseUrl) return;
      void (async () => {
        const result = await openFileInPreview({
          threadRef,
          filePath: joinWorkspacePath(cwd, relativePath),
          httpBaseUrl: environmentHttpBaseUrl,
          createAssetUrl,
          openPreview,
        });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        showMutationError(squashAtomCommandFailure(result), "Unable to open file in browser");
      })();
    },
    [createAssetUrl, cwd, environmentHttpBaseUrl, openPreview, showMutationError, threadRef],
  );

  const { model } = useFileTree({
    composition: { contextMenu: { enabled: true, triggerMode: "both" } },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T4CODE_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  // The menu model decides which actions show for a file vs a directory, so the full handler set is
  // supplied for every row. New File/Folder target the clicked folder itself, or a file's parent
  // directory. Copy Path uses the workspace-root separator style.
  const rowActions = useCallback(
    (relativePath: string, kind: FileTreeEntryKind): FileTreeMenuActions => {
      const targetDir = kind === "directory" ? relativePath : parentRelativePath(relativePath);
      return {
        onNewFile: () => createChildEntry(targetDir, "file"),
        onNewFolder: () => createChildEntry(targetDir, "directory"),
        onCopyPath: () => copyText(joinWorkspacePath(cwd, relativePath)),
        onCopyRelativePath: () => copyText(relativePath),
        onDuplicate: () => duplicateEntryAt(relativePath),
        onAddAsProject: () => addAsProject(joinWorkspacePath(cwd, relativePath)),
        onOpenExternalEditor: () => openExternalEditor(relativePath),
        onOpenPreview: () => openPreviewFor(relativePath),
        onRename: () => renameEntryAt(relativePath),
        onDelete: () => deleteEntryAt(relativePath, kind),
      };
    },
    [
      addAsProject,
      copyText,
      createChildEntry,
      cwd,
      deleteEntryAt,
      duplicateEntryAt,
      openExternalEditor,
      openPreviewFor,
      renameEntryAt,
    ],
  );

  const handleBackgroundContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    // A row right-click is handled by Pierre, which prevents the default contextmenu event; only
    // unhandled (empty-space) right-clicks reach here.
    if (event.defaultPrevented) return;
    event.preventDefault();
    setBackgroundMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const backgroundAnchor = useMemo(
    () =>
      backgroundMenu
        ? { getBoundingClientRect: () => new DOMRect(backgroundMenu.x, backgroundMenu.y, 0, 0) }
        : null,
    [backgroundMenu],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Collapse all folders"
          onClick={() => collapseDirectoryTreePaths(model, expandedTreePaths)}
        >
          <FolderClosed className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Expand all folders"
          onClick={() => model.resetPaths(treePaths, { initialExpandedPaths: expandedTreePaths })}
        >
          <FolderOpen className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search workspace files"
          onClick={() => model.openSearch()}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-3.5", entriesQuery.isPending && "animate-spin")} />
        </button>
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          onContextMenu={handleBackgroundContextMenu}
          renderContextMenu={(item, context) => {
            const relativePath = stripTrailingSlash(item.path);
            const entryKind: FileTreeEntryKind = item.kind === "directory" ? "directory" : "file";
            const menuModel = buildFileTreeMenuModel({
              entryKind,
              isPreviewable:
                item.kind === "file" &&
                isPreviewSupportedInRuntime() &&
                isBrowserPreviewFile(relativePath),
              isMarkdown: item.kind === "file" && isMarkdownPreviewFile(relativePath),
              isPrimaryEnv,
              hasWorkspaceRoot,
            });
            return (
              <FileTreeContextMenu
                model={menuModel}
                actions={rowActions(relativePath, entryKind)}
                anchor={{
                  getBoundingClientRect: () => context.anchorElement.getBoundingClientRect(),
                }}
                onClose={() => context.close()}
              />
            );
          }}
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
      {backgroundMenu ? (
        <FileTreeContextMenu
          model={buildFileTreeMenuModel({
            entryKind: "background",
            isPreviewable: false,
            isMarkdown: false,
            isPrimaryEnv,
            hasWorkspaceRoot,
          })}
          actions={{
            onNewFile: () => createChildEntry("", "file"),
            onNewFolder: () => createChildEntry("", "directory"),
            onCopyPath: () => copyText(cwd),
            onRefresh: () => entriesQuery.refresh(),
          }}
          anchor={backgroundAnchor}
          onClose={() => setBackgroundMenu(null)}
        />
      ) : null}
      <FileEntryDialog request={dialogRequest} onClose={() => setDialogRequest(null)} />
    </div>
  );
}
