import type { CenterSurface } from "~/centerPanelStore";
import { ThreadId } from "@t4code/contracts";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  api: null as null | { contextMenu: { show: ReturnType<typeof vi.fn> } },
  refCurrent: null as null | { querySelector: ReturnType<typeof vi.fn> },
  effects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void) => {
      harness.effects.push(effect);
      effect();
    },
    useRef: () => ({ current: harness.refCurrent }),
  };
});
vi.mock("~/localApi", () => ({ readLocalApi: () => harness.api }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { CenterPanelTabs } from "./CenterPanelTabs";

const host = { id: "chat:host", kind: "chat-host" } as const;
const chat = {
  id: "chat:thread-2",
  kind: "chat",
  threadId: ThreadId.make("thread-2"),
  providerLabel: "Claude",
} as const;
const terminal = {
  id: "terminal:terminal-1",
  kind: "terminal",
  terminalId: "terminal-1",
} as const;

function props(surfaces: CenterSurface[] = [host, chat, terminal]) {
  return {
    surfaces,
    activeSurfaceId: chat.id,
    terminalLabelsById: new Map([["terminal-1", "Build terminal"]]),
    onActivate: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOtherSurfaces: vi.fn(),
    onCloseSurfacesToRight: vi.fn(),
    onCloseAllSurfaces: vi.fn(),
  };
}

function visit(node: React.ReactNode, entries: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, entries);
    return entries;
  }
  if (!React.isValidElement(node)) return entries;
  entries.push(node);
  visit((node.props as { children?: React.ReactNode }).children, entries);
  const render = (node.props as { render?: React.ReactNode }).render;
  if (render) visit(render, entries);
  return entries;
}

beforeEach(() => {
  harness.api = null;
  harness.refCurrent = null;
  harness.effects.length = 0;
});

describe("CenterPanelTabs", () => {
  it("renders every surface title and scrolls the active tab into view", () => {
    const scrollIntoView = vi.fn();
    harness.refCurrent = { querySelector: vi.fn(() => ({ scrollIntoView })) };
    const input = props();
    const markup = renderToStaticMarkup(<CenterPanelTabs {...input} />);

    expect(markup).toContain("Main");
    expect(markup).toContain("Claude");
    expect(markup).toContain("Build terminal");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });

    const { terminalLabelsById: _terminalLabelsById, ...unlabeledProps } = props([
      { id: chat.id, kind: "chat", threadId: chat.threadId },
      terminal,
    ]);
    const unlabeled = renderToStaticMarkup(<CenterPanelTabs {...unlabeledProps} />);
    expect(unlabeled).toContain("Chat");
    expect(unlabeled).toContain("Terminal 1");
  });

  it("returns null for an empty surface collection", () => {
    expect(CenterPanelTabs(props([]))).toBeNull();
  });

  it("handles activation, close buttons, middle click, and context-menu actions", async () => {
    const surfaces: CenterSurface[] = [host, chat, terminal];
    const input = props(surfaces);
    const tree = CenterPanelTabs(input);
    const elements = visit(tree);
    const chatTab = elements.find(
      (element) =>
        element.type === "div" &&
        (element.props as Record<string, unknown>)["data-active-tab"] === true,
    );
    if (!chatTab) throw new Error("Active chat tab not found");
    const tabProps = chatTab.props as Record<string, unknown>;

    const mouseEvent = (button: number) => ({
      button,
      clientX: 10,
      clientY: 20,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    const leftDown = mouseEvent(0);
    (tabProps.onMouseDown as (event: unknown) => void)(leftDown);
    expect(leftDown.preventDefault).not.toHaveBeenCalled();
    const middleDown = mouseEvent(1);
    (tabProps.onMouseDown as (event: unknown) => void)(middleDown);
    expect(middleDown.preventDefault).toHaveBeenCalled();

    const leftAux = mouseEvent(0);
    (tabProps.onAuxClick as (event: unknown) => void)(leftAux);
    expect(input.onCloseSurface).not.toHaveBeenCalled();
    const middleAux = mouseEvent(1);
    (tabProps.onAuxClick as (event: unknown) => void)(middleAux);
    expect(input.onCloseSurface).toHaveBeenCalledWith(chat);
    expect(middleAux.stopPropagation).toHaveBeenCalled();

    const chatElements = visit(chatTab, []);
    const activate = chatElements.find(
      (element) =>
        element.type === "button" &&
        (element.props as Record<string, unknown>).className ===
          "flex min-w-0 flex-1 items-center gap-1.5",
    );
    if (!activate) throw new Error("Activate button not found");
    (activate.props as { onClick: () => void }).onClick();
    expect(input.onActivate).toHaveBeenCalledWith(chat);
    const close = chatElements.find(
      (element) =>
        element.type === "button" &&
        (element.props as Record<string, unknown>)["aria-label"] === "Close Claude",
    );
    if (!close) throw new Error("Close button not found");
    (close.props as { onClick: () => void }).onClick();
    expect(input.onCloseSurface).toHaveBeenCalledWith(chat);

    const contextEvent = mouseEvent(0);
    await (tabProps.onContextMenu as (event: unknown) => Promise<void>)(contextEvent);
    expect(contextEvent.preventDefault).toHaveBeenCalled();
    expect(contextEvent.stopPropagation).toHaveBeenCalled();

    const show = vi.fn();
    harness.api = { contextMenu: { show } };
    for (const [action, callback] of [
      ["close", input.onCloseSurface],
      ["close-others", input.onCloseOtherSurfaces],
      ["close-to-right", input.onCloseSurfacesToRight],
      ["close-all", input.onCloseAllSurfaces],
      [null, vi.fn()],
    ] as const) {
      show.mockResolvedValueOnce(action);
      await (tabProps.onContextMenu as (event: unknown) => Promise<void>)(mouseEvent(0));
      if (action === "close-all") expect(callback).toHaveBeenCalledWith();
      else if (action !== null) expect(callback).toHaveBeenCalledWith(chat);
    }
    expect(show).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "close-others", disabled: false }),
        expect.objectContaining({ id: "close-to-right", disabled: false }),
      ]),
      { x: 10, y: 20 },
    );

    surfaces.splice(1, 1);
    show.mockClear();
    await (tabProps.onContextMenu as (event: unknown) => Promise<void>)(mouseEvent(0));
    expect(show).not.toHaveBeenCalled();
  });
});
