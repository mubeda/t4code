import type { ContextMenuItem } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { Bot, MessageSquare, TerminalSquare, X } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef } from "react";

import type { CenterSurface } from "~/centerPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScrollArea } from "~/components/ui/scroll-area";

interface CenterPanelTabsProps {
  surfaces: readonly CenterSurface[];
  activeSurfaceId: string | null;
  terminalLabelsById?: ReadonlyMap<string, string>;
  onActivate: (surface: CenterSurface) => void;
  onCloseSurface: (surface: CenterSurface) => void;
  onCloseOtherSurfaces: (surface: CenterSurface) => void;
  onCloseSurfacesToRight: (surface: CenterSurface) => void;
  onCloseAllSurfaces: () => void;
}

type TabContextMenuAction = "close" | "close-others" | "close-to-right" | "close-all";

function centerSurfaceTitle(
  surface: CenterSurface,
  terminalLabelsById: ReadonlyMap<string, string> | undefined,
): string {
  switch (surface.kind) {
    case "chat-host":
      return "Main";
    case "chat":
      return surface.providerLabel ?? "Chat";
    case "terminal":
      return terminalLabelsById?.get(surface.terminalId) ?? getTerminalLabel(surface.terminalId);
  }
}

function CenterSurfaceIcon({ surface }: { surface: CenterSurface }) {
  switch (surface.kind) {
    case "chat-host":
      return <MessageSquare className="size-3.5 shrink-0" />;
    case "chat":
      return <Bot className="size-3.5 shrink-0" />;
    case "terminal":
      return <TerminalSquare className="size-3.5 shrink-0" />;
  }
}

export function CenterPanelTabs(props: CenterPanelTabsProps) {
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: CenterSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [
        { id: "close", label: "Close" },
        { id: "close-others", label: "Close others", disabled: props.surfaces.length <= 1 },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        { id: "close-all", label: "Close all", disabled: props.surfaces.length === 0 },
      ];

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );

  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);

  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: CenterSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  if (props.surfaces.length === 0) return null;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2"
      data-center-panel-tabbar
    >
      <ScrollArea
        ref={tabListRef}
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1 rounded-none"
        data-center-panel-tab-list
      >
        <div className="flex h-full w-max min-w-full items-center gap-1">
          {props.surfaces.map((surface) => {
            const active = surface.id === props.activeSurfaceId;
            const title = centerSurfaceTitle(surface, props.terminalLabelsById);
            return (
              <div
                key={surface.id}
                data-active-tab={active}
                onMouseDown={handleTabMouseDown}
                onAuxClick={(event) => handleTabAuxClick(event, surface)}
                onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                className={cn(
                  "group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5"
                        onClick={() => props.onActivate(surface)}
                      >
                        <CenterSurfaceIcon surface={surface} />
                        <span className="truncate">{title}</span>
                      </button>
                    }
                  />
                  <TooltipPopup>{title}</TooltipPopup>
                </Tooltip>
                <button
                  type="button"
                  className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
                  aria-label={`Close ${title}`}
                  onClick={() => props.onCloseSurface(surface)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
