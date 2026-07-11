import type { VcsStagingArea } from "@t4code/contracts";
import { Fragment, useState, type ReactNode } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { splitFilePath, type WorkingTreeFile } from "./SourceControlPanel.logic";
import {
  buildRowContextMenu,
  getRowActions,
  rowAreaOf,
  type RowActionDescriptor,
  type RowContextMenuItemId,
} from "./SourceControlRowActions.logic";

/**
 * Per-file affordances for a change row. All optional so existing call sites (and
 * legacy servers) compile unchanged; the panel wires the ones it can support.
 * Discard and delete both route through `onRequestDiscardFile` — the panel decides
 * the discard-vs-delete confirm copy from the file's area/status.
 */
export interface SourceControlRowActions {
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onRequestDiscardFile?: (file: WorkingTreeFile) => void;
  onOpenExternalEditor?: (path: string) => void;
  onCopyPath?: (path: string, relative: boolean) => void;
  onViewFile?: (path: string, area?: VcsStagingArea) => void;
  onIgnoreFileName?: (path: string) => void;
  onIgnoreParentFolder?: (path: string) => void;
}

interface SourceControlChangesListProps extends SourceControlRowActions {
  files: readonly WorkingTreeFile[];
  /**
   * When provided, a per-row stage/unstage checkbox is rendered, reflecting
   * whether the given file is currently staged. Omit this (legacy servers
   * without stage/unstage RPCs) to render no checkbox at all.
   */
  checked?: (file: WorkingTreeFile) => boolean;
  selected?: (file: WorkingTreeFile) => boolean;
  onSelect?: (path: string, selected: boolean) => void;
  onToggle: (path: string) => void;
  /** Opens the file's diff; the area lets the panel pick staged vs unstaged scope. */
  onOpenFile: (path: string, area?: VcsStagingArea) => void;
  renderBadge?: (file: WorkingTreeFile) => ReactNode;
  disabled?: boolean;
  /** Gates the primary-env-only "Open in External Editor" context-menu item. */
  isPrimaryEnv?: boolean;
}

interface RowMenuState {
  file: WorkingTreeFile;
  x: number;
  y: number;
}

export function SourceControlChangesList(props: SourceControlChangesListProps) {
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const viewFile = props.onViewFile ?? props.onOpenFile;

  if (props.files.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">No changes</p>;
  }

  function rowActionHandler(
    action: RowActionDescriptor,
    file: WorkingTreeFile,
  ): (() => void) | undefined {
    switch (action.kind) {
      case "stage": {
        const handler = props.onStageFile;
        return handler ? () => handler(file.path) : undefined;
      }
      case "unstage": {
        const handler = props.onUnstageFile;
        return handler ? () => handler(file.path) : undefined;
      }
      case "discard":
      case "delete": {
        const handler = props.onRequestDiscardFile;
        return handler ? () => handler(file) : undefined;
      }
    }
  }

  return (
    <div className="space-y-0.5 p-1">
      {props.files.map((file) => {
        const { dir, name } = splitFilePath(file.path);
        const isChecked = props.checked?.(file) ?? false;
        const rowActions = getRowActions(rowAreaOf(file.area), file.status).flatMap((action) => {
          const onClick = rowActionHandler(action, file);
          return onClick ? [{ action, onClick }] : [];
        });
        return (
          <div
            key={file.path}
            className="group relative flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50"
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ file, x: event.clientX, y: event.clientY });
            }}
          >
            {props.checked ? (
              <Checkbox
                checked={isChecked}
                onCheckedChange={() => props.onToggle(file.path)}
                disabled={props.disabled}
                aria-label={isChecked ? `Unstage ${file.path}` : `Stage ${file.path}`}
              />
            ) : null}
            {props.onSelect ? (
              <Checkbox
                checked={props.selected?.(file) ?? false}
                onCheckedChange={(selected) => props.onSelect?.(file.path, selected === true)}
                disabled={props.disabled}
                aria-label={`Select ${file.path}`}
              />
            ) : null}
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => props.onOpenFile(file.path, file.area)}
              title={file.path}
            >
              <span className="shrink-0 truncate font-mono text-xs">{name}</span>
              {dir ? (
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir}</span>
              ) : null}
              <DiffStatLabel
                additions={file.insertions}
                deletions={file.deletions}
                layout="inline"
                className="ml-auto shrink-0 text-[11px]"
              />
              {props.renderBadge?.(file)}
            </button>
            {rowActions.length > 0 ? (
              <div className="pointer-events-none flex shrink-0 items-center gap-0.5 rounded-md bg-accent px-0.5 opacity-0 shadow-sm transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                {rowActions.map(({ action, onClick }) => (
                  <Button
                    key={action.kind}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={props.disabled}
                    aria-label={`${action.label} ${file.path}`}
                    title={action.label}
                    className={cn(action.destructive && "text-destructive hover:text-destructive")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClick();
                    }}
                  >
                    <action.icon className="size-3.5" />
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      <SourceControlRowContextMenu
        state={menu}
        isPrimaryEnv={props.isPrimaryEnv ?? false}
        onView={(file) => viewFile(file.path, file.area)}
        {...(props.onCopyPath ? { onCopyPath: props.onCopyPath } : {})}
        {...(props.onOpenExternalEditor
          ? { onOpenExternalEditor: props.onOpenExternalEditor }
          : {})}
        {...(props.onIgnoreFileName ? { onIgnoreFileName: props.onIgnoreFileName } : {})}
        {...(props.onIgnoreParentFolder
          ? { onIgnoreParentFolder: props.onIgnoreParentFolder }
          : {})}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

interface RowContextMenuProps {
  state: RowMenuState | null;
  isPrimaryEnv: boolean;
  onView: (file: WorkingTreeFile) => void;
  onCopyPath?: (path: string, relative: boolean) => void;
  onOpenExternalEditor?: (path: string) => void;
  onIgnoreFileName?: (path: string) => void;
  onIgnoreParentFolder?: (path: string) => void;
  onClose: () => void;
}

/**
 * Navigation-only right-click menu, anchored at the cursor via a virtual point
 * (see FileBrowserPanel's background menu). Items whose host handler is unwired
 * are dropped so the menu never shows a dead entry.
 */
function SourceControlRowContextMenu(props: RowContextMenuProps) {
  const { state } = props;
  if (!state) return null;
  const { file } = state;

  const handlerFor = (id: RowContextMenuItemId): (() => void) | undefined => {
    switch (id) {
      case "view":
        return () => props.onView(file);
      case "copy-path": {
        const handler = props.onCopyPath;
        return handler ? () => handler(file.path, false) : undefined;
      }
      case "copy-relative-path": {
        const handler = props.onCopyPath;
        return handler ? () => handler(file.path, true) : undefined;
      }
      case "ignore-file-name": {
        const handler = props.onIgnoreFileName;
        return handler ? () => handler(file.path) : undefined;
      }
      case "ignore-parent-folder": {
        const handler = props.onIgnoreParentFolder;
        return handler ? () => handler(file.path) : undefined;
      }
      case "open-external-editor": {
        const handler = props.onOpenExternalEditor;
        return handler ? () => handler(file.path) : undefined;
      }
    }
  };

  const groups = buildRowContextMenu({ isPrimaryEnv: props.isPrimaryEnv })
    .groups.map((group) =>
      group.flatMap((item) => {
        const onClick = handlerFor(item.id);
        return onClick ? [{ item, onClick }] : [];
      }),
    )
    .filter((group) => group.length > 0);
  if (groups.length === 0) return null;

  const anchor = { getBoundingClientRect: () => new DOMRect(state.x, state.y, 0, 0) };

  return (
    <Menu
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <MenuPopup
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={2}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {groups.map((group, index) => (
          <Fragment key={group.map((entry) => entry.item.id).join(",")}>
            {index > 0 ? <MenuSeparator /> : null}
            {group.map(({ item, onClick }) => (
              <MenuItem
                key={item.id}
                disabled={!item.enabled}
                onClick={() => {
                  onClick();
                  props.onClose();
                }}
              >
                {item.label}
              </MenuItem>
            ))}
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
