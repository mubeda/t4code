import type { VcsStagingArea } from "@t3tools/contracts";
import { ChevronDownIcon, MinusIcon, PlusIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { SourceControlChangesList, type SourceControlRowActions } from "./SourceControlChangesList";
import { workingTreeStatusBadge } from "~/sourceControlStatus";
import type { WorkingTreeFile } from "./SourceControlPanel.logic";

interface SourceControlSectionProps extends SourceControlRowActions {
  title: string;
  files: readonly WorkingTreeFile[];
  /** See `SourceControlChangesListProps.checked` — omit to render no checkbox. */
  checked?: (file: WorkingTreeFile) => boolean;
  selected?: (file: WorkingTreeFile) => boolean;
  onSelect?: (path: string, selected: boolean) => void;
  onToggle: (path: string) => void;
  onOpenFile: (path: string, area?: VcsStagingArea) => void;
  primaryAction?: { icon: "stage" | "unstage"; label: string; onClick: () => void };
  onDiscard?: () => void;
  /**
   * How the discard-all header button reads. Default "discard-all" (Undo2Icon,
   * "Discard all"); "delete-untracked" renders a destructive Trash2Icon
   * "Delete all untracked" for the untracked section.
   */
  discardVariant?: "discard-all" | "delete-untracked";
  disabled?: boolean;
  /** Gates the primary-env-only "Open in External Editor" context-menu item. */
  isPrimaryEnv?: boolean;
}

export function SourceControlSection(props: SourceControlSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  if (props.files.length === 0) return null;
  const deleteAllVariant = props.discardVariant === "delete-untracked";
  return (
    <div className="min-h-0">
      <div className="group flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex flex-1 items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", collapsed && "-rotate-90")}
          />
          {props.title}
          <span className="ml-1">{props.files.length}</span>
        </button>
        {props.primaryAction ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={props.primaryAction.label}
            onClick={props.primaryAction.onClick}
            disabled={props.disabled}
          >
            {props.primaryAction.icon === "stage" ? (
              <PlusIcon className="size-3.5" />
            ) : (
              <MinusIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
        {props.onDiscard ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={deleteAllVariant ? "Delete all untracked" : "Discard all"}
            title={deleteAllVariant ? "Delete all untracked" : "Discard all"}
            onClick={props.onDiscard}
            disabled={props.disabled}
            className={cn(deleteAllVariant && "text-destructive hover:text-destructive")}
          >
            {deleteAllVariant ? (
              <Trash2Icon className="size-3.5" />
            ) : (
              <Undo2Icon className="size-3.5" />
            )}
          </Button>
        ) : null}
      </div>
      {collapsed ? null : (
        <SourceControlChangesList
          files={props.files}
          onToggle={props.onToggle}
          onOpenFile={props.onOpenFile}
          {...(props.checked ? { checked: props.checked } : {})}
          {...(props.selected ? { selected: props.selected } : {})}
          {...(props.onSelect ? { onSelect: props.onSelect } : {})}
          {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
          {...(props.isPrimaryEnv !== undefined ? { isPrimaryEnv: props.isPrimaryEnv } : {})}
          {...(props.onStageFile ? { onStageFile: props.onStageFile } : {})}
          {...(props.onUnstageFile ? { onUnstageFile: props.onUnstageFile } : {})}
          {...(props.onRequestDiscardFile
            ? { onRequestDiscardFile: props.onRequestDiscardFile }
            : {})}
          {...(props.onOpenExternalEditor
            ? { onOpenExternalEditor: props.onOpenExternalEditor }
            : {})}
          {...(props.onCopyPath ? { onCopyPath: props.onCopyPath } : {})}
          {...(props.onViewFile ? { onViewFile: props.onViewFile } : {})}
          {...(props.onIgnoreFileName ? { onIgnoreFileName: props.onIgnoreFileName } : {})}
          {...(props.onIgnoreParentFolder
            ? { onIgnoreParentFolder: props.onIgnoreParentFolder }
            : {})}
          renderBadge={(file) => {
            const badge = workingTreeStatusBadge(file.status);
            return (
              <span
                className={cn("w-4 shrink-0 text-center text-[10px] font-bold", badge.className)}
                title={badge.label}
              >
                {badge.letter}
              </span>
            );
          }}
        />
      )}
    </div>
  );
}
