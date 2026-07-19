import type { ServerProvider, ServerSettings } from "@t4code/contracts";
import { PlusIcon, TerminalSquare } from "lucide-react";
import { memo, type ReactElement } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { buildPanelMenuModel } from "./ChatHeaderPanelMenu.logic";
import {
  resolveProviderTerminalAction,
  type ProviderTerminalAction,
} from "./providerTerminalActions";

interface ChatHeaderPanelMenuProps {
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers">;
  /** False when the host thread can't yet spawn sibling panels (no thread ref). */
  readonly canCreatePanel: boolean;
  readonly onCreateChatPanel: (entry: ProviderInstanceEntry) => void;
  readonly onOpenTerminalPanel: () => void;
  readonly onOpenProviderTerminalPanel: (action: ProviderTerminalAction) => void;
  readonly onAddCustomAction: () => void;
}

const PANEL_UNAVAILABLE_REASON = "Available once this thread has started.";

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The chat-header "+" menu: create a new chat panel for any enabled provider
 * instance, open a center terminal panel, or add a custom project action
 * (the entry point that replaces ProjectScriptsControl's old bare "+").
 */
export const ChatHeaderPanelMenu = memo(function ChatHeaderPanelMenu({
  providerStatuses,
  settings,
  canCreatePanel,
  onCreateChatPanel,
  onOpenTerminalPanel,
  onOpenProviderTerminalPanel,
  onAddCustomAction,
}: ChatHeaderPanelMenuProps) {
  const providerItems = buildPanelMenuModel(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
  );
  const providerTerminalItems = providerItems.flatMap((item) => {
    const action = resolveProviderTerminalAction(item.entry, settings);
    return action ? [{ item, action }] : [];
  });

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="outline" aria-label="New panel" />}>
        <PlusIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        {providerItems.map((item) => {
          const disabled = item.disabled || !canCreatePanel;
          const reason = canCreatePanel ? item.disabledReason : PANEL_UNAVAILABLE_REASON;
          const menuItem = (
            <MenuItem
              key={item.entry.instanceId}
              className={disabled ? "data-disabled:pointer-events-auto" : undefined}
              disabled={disabled}
              onClick={() => onCreateChatPanel(item.entry)}
            >
              <ProviderInstanceIcon
                driverKind={item.entry.driverKind}
                displayName={item.entry.displayName}
                accentColor={item.entry.accentColor}
                iconClassName="size-4"
              />
              <span className="truncate">{item.entry.displayName}</span>
            </MenuItem>
          );
          return disabled && reason ? (
            <DisabledReasonTooltip key={item.entry.instanceId} reason={reason} trigger={menuItem} />
          ) : (
            menuItem
          );
        })}
        {providerItems.length > 0 ? <MenuSeparator /> : null}
        {canCreatePanel ? (
          <MenuItem onClick={onOpenTerminalPanel}>
            <TerminalSquare className="size-4" />
            Open Terminal
          </MenuItem>
        ) : (
          <DisabledReasonTooltip
            reason={PANEL_UNAVAILABLE_REASON}
            trigger={
              <MenuItem className="data-disabled:pointer-events-auto" disabled>
                <TerminalSquare className="size-4" />
                Open Terminal
              </MenuItem>
            }
          />
        )}
        {providerTerminalItems.length > 0 ? (
          <>
            <MenuSeparator />
            {providerTerminalItems.map(({ item, action }) => {
              const disabled = item.disabled || !canCreatePanel;
              const reason = canCreatePanel ? item.disabledReason : PANEL_UNAVAILABLE_REASON;
              const menuItem = (
                <MenuItem
                  key={`terminal:${item.entry.instanceId}`}
                  className={disabled ? "data-disabled:pointer-events-auto" : undefined}
                  disabled={disabled}
                  onClick={() => onOpenProviderTerminalPanel(action)}
                >
                  <ProviderInstanceIcon
                    driverKind={item.entry.driverKind}
                    displayName={item.entry.displayName}
                    accentColor={item.entry.accentColor}
                    iconClassName="size-4"
                  />
                  <span className="truncate">{action.label}</span>
                </MenuItem>
              );
              return disabled && reason ? (
                <DisabledReasonTooltip
                  key={`terminal:${item.entry.instanceId}`}
                  reason={reason}
                  trigger={menuItem}
                />
              ) : (
                menuItem
              );
            })}
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onAddCustomAction}>
          <PlusIcon className="size-4" />
          Add custom action…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});

export default ChatHeaderPanelMenu;
