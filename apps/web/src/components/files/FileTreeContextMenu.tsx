import { Fragment } from "react";
import type * as React from "react";

import { Menu, MenuItem, MenuPopup, MenuSeparator } from "~/components/ui/menu";

import { type FileTreeMenuItemId, type FileTreeMenuModel } from "./FileTreeContextMenu.logic";

/**
 * Every menu action. All optional so a host can wire the actions it can support and leave the rest
 * unset; an item whose handler is absent is dropped so the menu never shows a dead entry (e.g. Open
 * in Preview when the host can't supply a thread ref). FileBrowserPanel wires the mutation actions
 * (new/rename/delete/duplicate) to the projects.* RPCs.
 */
export interface FileTreeMenuActions {
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onCopyPath?: () => void;
  onCopyRelativePath?: () => void;
  onDuplicate?: () => void;
  onAddAsProject?: () => void;
  onOpenExternalEditor?: () => void;
  onOpenPreview?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onRefresh?: () => void;
}

const ACTION_BY_ID: Record<FileTreeMenuItemId, keyof FileTreeMenuActions> = {
  "new-file": "onNewFile",
  "new-folder": "onNewFolder",
  "copy-path": "onCopyPath",
  "copy-relative-path": "onCopyRelativePath",
  duplicate: "onDuplicate",
  "add-as-project": "onAddAsProject",
  "open-external-editor": "onOpenExternalEditor",
  "open-preview": "onOpenPreview",
  rename: "onRename",
  delete: "onDelete",
  refresh: "onRefresh",
};

type MenuAnchor = React.ComponentProps<typeof MenuPopup>["anchor"];

interface FileTreeContextMenuProps {
  model: FileTreeMenuModel;
  actions: FileTreeMenuActions;
  /** Element (row) or virtual point (background) the menu positions against. */
  anchor: MenuAnchor;
  /** Close the menu — for Pierre rows this is `context.close`, for background the local setter. */
  onClose: () => void;
}

export default function FileTreeContextMenu({
  model,
  actions,
  anchor,
  onClose,
}: FileTreeContextMenuProps) {
  const groups = model.groups
    .map((group) => group.filter((item) => Boolean(actions[ACTION_BY_ID[item.id]])))
    .filter((group) => group.length > 0);

  if (groups.length === 0) return null;

  return (
    <Menu
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPopup
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={2}
        data-file-tree-context-menu-root="true"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {groups.map((group, index) => (
          <Fragment key={group.map((item) => item.id).join(",")}>
            {index > 0 ? <MenuSeparator /> : null}
            {group.map((item) => {
              const handler = actions[ACTION_BY_ID[item.id]];
              return (
                <MenuItem
                  key={item.id}
                  disabled={!item.enabled}
                  variant={item.destructive ? "destructive" : "default"}
                  onClick={() => {
                    handler?.();
                    onClose();
                  }}
                >
                  {item.label}
                </MenuItem>
              );
            })}
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
