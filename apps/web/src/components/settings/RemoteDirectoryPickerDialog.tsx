import {
  ArrowUpIcon,
  ChevronRightIcon,
  FolderIcon,
  HardDriveIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t4code/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";

export interface RemoteDirectoryPickerDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly initialPath: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (path: string) => void;
}

export function RemoteDirectoryPickerDialog({
  open,
  environmentId,
  initialPath,
  onOpenChange,
  onSelect,
}: RemoteDirectoryPickerDialogProps) {
  const [path, setPath] = useState(initialPath || "~");
  const [fallbackWarning, setFallbackWarning] = useState<string | null>(null);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);

  useEffect(() => {
    if (open) {
      setPath(initialPath || "~");
      setFallbackWarning(null);
      setShowHiddenFolders(false);
    }
  }, [environmentId, initialPath, open]);

  const query = useEnvironmentQuery(
    open
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: path, mode: "directory" },
        })
      : null,
  );
  const directoryPath = query.data?.directoryPath ?? null;
  const breadcrumbs = query.data?.breadcrumbs ?? [];
  const entries = query.data?.entries ?? [];
  const hiddenFolderCount = entries.filter((entry) => entry.name.startsWith(".")).length;
  const visibleEntries = showHiddenFolders
    ? entries
    : entries.filter((entry) => !entry.name.startsWith("."));
  const displayPath = directoryPath ?? path;

  useEffect(() => {
    if (open && query.error && path !== "~" && fallbackWarning === null) {
      setFallbackWarning("The previous folder is unavailable. Showing the server home directory.");
      setPath("~");
    }
  }, [fallbackWarning, open, path, query.error]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader className="pb-4">
          <DialogTitle>Select Workspace folder</DialogTitle>
          <DialogDescription>Browse directories on the selected T4Code host.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5 px-6 pb-5">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Up one directory"
              disabled={!query.data?.ancestorPath || query.isPending}
              onClick={() => {
                if (query.data?.ancestorPath) setPath(query.data.ancestorPath);
              }}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
            <DraftInput
              value={displayPath}
              onCommit={setPath}
              aria-label="Server directory path"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <Button type="button" variant="outline" size="sm" onClick={query.refresh}>
              Refresh
            </Button>
          </div>
          <nav
            aria-label="Directory breadcrumbs"
            className="flex min-h-8 items-center overflow-x-auto rounded-lg border bg-muted/24 px-1.5"
          >
            {breadcrumbs.map((breadcrumb, index) => {
              const isCurrent = index === breadcrumbs.length - 1;
              return (
                <div key={breadcrumb.fullPath} className="flex shrink-0 items-center">
                  {index > 0 ? (
                    <ChevronRightIcon
                      aria-hidden="true"
                      className="size-3 text-muted-foreground/50"
                      data-directory-breadcrumb-separator=""
                    />
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Open ${breadcrumb.name}`}
                    aria-current={isCurrent ? "page" : undefined}
                    className={
                      isCurrent
                        ? "max-w-44 gap-1.5 px-1.5 font-medium"
                        : "max-w-44 gap-1.5 px-1.5 font-normal text-muted-foreground"
                    }
                    title={breadcrumb.fullPath}
                    onClick={() => setPath(breadcrumb.fullPath)}
                  >
                    {index === 0 ? (
                      <HardDriveIcon className="size-3.5" />
                    ) : isCurrent ? (
                      <FolderIcon className="size-3.5" />
                    ) : null}
                    <span className="truncate">{breadcrumb.name}</span>
                  </Button>
                </div>
              );
            })}
          </nav>
          <div className="overflow-hidden rounded-lg border bg-background">
            <div className="flex min-h-8 items-center justify-between border-b bg-muted/36 px-3">
              <span className="text-xs font-medium text-muted-foreground">Folders</span>
              {hiddenFolderCount > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="-mr-1 h-6 px-1.5 font-normal text-muted-foreground"
                  onClick={() => setShowHiddenFolders((current) => !current)}
                >
                  {showHiddenFolders ? "Hide hidden folders" : "Show hidden folders"}
                </Button>
              ) : null}
            </div>
            <div className="max-h-72 min-h-48 overflow-y-auto py-1">
              {visibleEntries.map((entry) => (
                <Button
                  type="button"
                  variant="ghost"
                  key={entry.fullPath}
                  aria-label={`Open ${entry.name}`}
                  className="h-8 w-full justify-start rounded-none border-0 px-3 py-1.5 font-normal text-left shadow-none hover:bg-muted/72"
                  onClick={() => setPath(entry.fullPath)}
                >
                  <FolderIcon
                    aria-hidden="true"
                    className="size-4 text-muted-foreground/80"
                    data-directory-folder-icon=""
                  />
                  <span className="truncate">{entry.name}</span>
                </Button>
              ))}
              {query.isPending ? (
                <div
                  role="status"
                  className="flex min-h-40 flex-col items-center justify-center gap-2 px-3 text-sm text-muted-foreground"
                >
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  <span>Loading folders…</span>
                </div>
              ) : null}
              {!query.isPending && !query.error && visibleEntries.length === 0 ? (
                <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  {hiddenFolderCount > 0 && !showHiddenFolders
                    ? "No visible folders. Show hidden folders to browse hidden directories."
                    : "No folders in this location."}
                </div>
              ) : null}
            </div>
          </div>
          {fallbackWarning ? (
            <p role="status" className="text-sm text-muted-foreground">
              {fallbackWarning}
            </p>
          ) : null}
          {query.error ? (
            <p role="alert" className="text-sm text-destructive">
              {query.error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={directoryPath === null || query.isPending || query.error !== null}
            onClick={() => {
              if (directoryPath) onSelect(directoryPath);
            }}
          >
            Select folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
