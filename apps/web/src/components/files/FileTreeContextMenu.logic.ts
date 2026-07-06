// Pure decision + path helpers for the file-tree context menu. No React, no I/O — so the
// menu's shape (which items appear, whether they're enabled, and the fs-path math) is unit
// testable in isolation. The React shell (FileTreeContextMenu.tsx) renders this model.

export type FileTreeEntryKind = "file" | "directory" | "background";

export type FileTreeMenuItemId =
  | "new-file"
  | "new-folder"
  | "copy-path"
  | "copy-relative-path"
  | "duplicate"
  | "add-as-project"
  | "open-external-editor"
  | "open-preview"
  | "rename"
  | "delete"
  | "refresh";

export interface FileTreeMenuItem {
  id: FileTreeMenuItemId;
  label: string;
  enabled: boolean;
  destructive?: boolean;
}

export interface BuildFileTreeMenuModelInput {
  /** What was right-clicked: a file row, a directory row, or empty tree background. */
  entryKind: FileTreeEntryKind;
  /** File can be shown in the in-app preview browser (assets.createUrl + preview.open). */
  isPreviewable: boolean;
  /** File is markdown — reserved for a future "Open Markdown Preview" item. */
  isMarkdown: boolean;
  /** Environment is the primary one — external-editor launch is only offered there. */
  isPrimaryEnv: boolean;
  /** Workspace root is known, so an absolute path (Copy Path / Add as Project) can be computed. */
  hasWorkspaceRoot: boolean;
}

export interface FileTreeMenuModel {
  /** Ordered item groups; the renderer draws a separator between groups. */
  groups: FileTreeMenuItem[][];
}

// Mutation items are wired to the projects.* RPCs (createEntry/renameEntry/…) in FileBrowserPanel.
const NEW_FILE: FileTreeMenuItem = { id: "new-file", label: "New File…", enabled: true };
const NEW_FOLDER: FileTreeMenuItem = { id: "new-folder", label: "New Folder…", enabled: true };

export function buildFileTreeMenuModel(input: BuildFileTreeMenuModelInput): FileTreeMenuModel {
  const { entryKind, isPreviewable, isPrimaryEnv, hasWorkspaceRoot } = input;

  if (entryKind === "background") {
    return {
      groups: dropEmptyGroups([
        [NEW_FILE, NEW_FOLDER],
        [
          { id: "copy-path", label: "Copy Path", enabled: hasWorkspaceRoot },
          { id: "refresh", label: "Refresh", enabled: true },
        ],
      ]),
    };
  }

  const isFile = entryKind === "file";
  const isDirectory = entryKind === "directory";

  const actionGroup: FileTreeMenuItem[] = [
    { id: "copy-path", label: "Copy Path", enabled: hasWorkspaceRoot },
    { id: "copy-relative-path", label: "Copy Relative Path", enabled: true },
  ];
  if (isFile) {
    actionGroup.push({ id: "duplicate", label: "Duplicate", enabled: true });
  }
  if (isDirectory) {
    actionGroup.push({ id: "add-as-project", label: "Add as Project…", enabled: hasWorkspaceRoot });
  }
  if (isFile && isPrimaryEnv) {
    actionGroup.push({
      id: "open-external-editor",
      label: "Open in External Editor",
      enabled: true,
    });
  }
  if (isFile && isPreviewable) {
    actionGroup.push({ id: "open-preview", label: "Open in Preview", enabled: true });
  }

  const mutateGroup: FileTreeMenuItem[] = [
    { id: "rename", label: "Rename…", enabled: true },
    { id: "delete", label: "Delete", enabled: true, destructive: true },
  ];

  return { groups: dropEmptyGroups([[NEW_FILE, NEW_FOLDER], actionGroup, mutateGroup]) };
}

function dropEmptyGroups(groups: FileTreeMenuItem[][]): FileTreeMenuItem[][] {
  return groups.filter((group) => group.length > 0);
}

/**
 * Pierre directory paths carry a trailing "/" (see FileBrowserPanel treePath). Strip it before
 * treating the value as a filesystem-relative path.
 */
export function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Infer the path separator from an existing absolute path so we never hand-normalize to "/". */
export function detectPathSeparator(workspaceRoot: string): "\\" | "/" {
  return workspaceRoot.includes("\\") ? "\\" : "/";
}

/**
 * Join a workspace root and a tree-relative path into an absolute path, using the separator style
 * already present in the root (Windows-safe). The relative path may use either slash and may carry
 * a trailing slash (directories); both are normalized to the root's separator.
 */
export function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const separator = detectPathSeparator(workspaceRoot);
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const segments = stripTrailingSlash(relativePath)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return root;
  return [root, ...segments].join(separator);
}

/**
 * The directory portion of a tree-relative path — "" when the entry sits at the workspace root.
 * Tree-relative paths use forward slashes; a directory's trailing slash is stripped first.
 */
export function parentRelativePath(relativePath: string): string {
  const normalized = stripTrailingSlash(relativePath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash < 0 ? "" : normalized.slice(0, lastSlash);
}

/** The final segment (file/folder name) of a tree-relative path. */
export function entryName(relativePath: string): string {
  const normalized = stripTrailingSlash(relativePath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash < 0 ? normalized : normalized.slice(lastSlash + 1);
}

/** Join a relative directory and a child name into a tree-relative (forward-slash) path. */
export function joinRelativePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
