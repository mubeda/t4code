// @vitest-environment happy-dom

import type { PreviewSessionSnapshot } from "@t4code/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

const testState = vi.hoisted(() => ({
  contextMenuShow: vi.fn(),
  localApiAvailable: true,
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () =>
    testState.localApiAvailable ? { contextMenu: { show: testState.contextMenuShow } } : undefined,
}));

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render?: React.ReactNode;
    children?: React.ReactNode;
  }) => <>{render ?? children}</>,
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  ),
}));

vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  MenuPopup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    ref,
    hideScrollbars,
    scrollFade,
    ...props
  }: React.ComponentProps<"div"> & { hideScrollbars?: boolean; scrollFade?: boolean }) => {
    void hideScrollbars;
    void scrollFade;
    return (
      <div ref={ref} {...props}>
        {children}
      </div>
    );
  },
}));

vi.mock("./preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children, mode }: { children?: React.ReactNode; mode: string }) => (
    <section data-mode={mode}>{children}</section>
  ),
}));

vi.mock("./chat/PierreEntryIcon", () => ({
  PierreEntryIcon: ({ pathValue }: { pathValue: string }) => <span data-file-icon={pathValue} />,
}));

import { RightPanelTabs } from "./RightPanelTabs";

type TabsProps = Parameters<typeof RightPanelTabs>[0];

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
const suiteScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
let originalScrollIntoViewDescriptor: PropertyDescriptor | undefined;

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedTrees.push({ container, root });
  await act(async () => root.render(element));
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  return button!;
}

function snapshot(navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot {
  return {
    threadId: "thread-1",
    tabId: "preview-1",
    navStatus,
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

const fileSurface: RightPanelSurface = {
  id: "file:src/main.ts",
  kind: "file",
  relativePath: "src/main.ts",
  revealLine: null,
  revealRequestId: 0,
};
const previewSurface: RightPanelSurface = {
  id: "browser:1",
  kind: "preview",
  resourceId: "preview-1",
};

function tabsProps(overrides: Partial<TabsProps> = {}): TabsProps {
  return {
    mode: "inline",
    surfaces: [fileSurface, previewSurface],
    activeSurfaceId: fileSurface.id,
    pendingSurfaceIds: new Set<string>(),
    previewSessions: {
      "preview-1": snapshot({
        _tag: "Success",
        url: "https://example.test/docs",
        title: "Project docs",
      }),
    },
    terminalLabelsById: new Map<string, string>(),
    onActivate: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOtherSurfaces: vi.fn(),
    onCloseSurfacesToRight: vi.fn(),
    onCloseAllSurfaces: vi.fn(),
    onCopyFilePath: vi.fn(),
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddSourceControl: vi.fn(),
    browserAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    sourceControlAvailable: true,
    children: <div>active content</div>,
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testState.localApiAvailable = true;
  testState.contextMenuShow.mockReset().mockResolvedValue(null);
  originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
    writable: true,
  });
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  if (originalScrollIntoViewDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      originalScrollIntoViewDescriptor,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  originalScrollIntoViewDescriptor = undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")).toEqual(
    suiteScrollIntoViewDescriptor,
  );
});

describe("RightPanelTabs mounted interactions", () => {
  it("activates, closes, and middle-clicks rendered tabs", async () => {
    const onActivate = vi.fn();
    const onCloseSurface = vi.fn();
    await mount(<RightPanelTabs {...tabsProps({ onActivate, onCloseSurface })} />);

    expect(document.body.textContent).toContain("main.ts");
    expect(document.body.textContent).toContain("Project docs");
    await click(buttonWithText("Project docs"));
    expect(onActivate).toHaveBeenCalledWith(previewSurface);

    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close main.ts"]')!);
    expect(onCloseSurface).toHaveBeenCalledWith(fileSurface);

    const previewTab = buttonWithText("Project docs").parentElement!;
    await act(async () => {
      previewTab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(onCloseSurface).toHaveBeenLastCalledWith(previewSurface);
  });

  it("opens the native tab context menu and copies a file path", async () => {
    const onCopyFilePath = vi.fn();
    testState.contextMenuShow.mockResolvedValue("copy-path");
    await mount(<RightPanelTabs {...tabsProps({ onCopyFilePath })} />);

    const fileTab = buttonWithText("main.ts").parentElement!;
    await act(async () => {
      fileTab.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 34,
        }),
      );
    });

    expect(testState.contextMenuShow).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "copy-path", label: "Copy path" }),
        expect.objectContaining({ id: "close", label: "Close" }),
      ]),
      { x: 12, y: 34 },
    );
    expect(onCopyFilePath).toHaveBeenCalledWith("src/main.ts");
  });

  it("uses real empty-state buttons and respects unavailable surfaces", async () => {
    const onAddTerminal = vi.fn();
    const onAddBrowser = vi.fn();
    await mount(
      <RightPanelTabs
        {...tabsProps({
          surfaces: [],
          activeSurfaceId: null,
          browserAvailable: false,
          onAddTerminal,
          onAddBrowser,
        })}
      />,
    );

    await click(buttonWithText("TerminalStart a shell in this workspace."));
    expect(onAddTerminal).toHaveBeenCalledOnce();

    const browserButton = buttonWithText("BrowserOpen a local app or URL.");
    expect(browserButton.getAttribute("aria-disabled")).toBe("true");
    await click(browserButton);
    expect(onAddBrowser).not.toHaveBeenCalled();
  });

  it("adds a surface from the rendered panel menu", async () => {
    const onAddFiles = vi.fn();
    await mount(<RightPanelTabs {...tabsProps({ onAddFiles })} />);

    await click(document.querySelector<HTMLButtonElement>('[aria-label="Add panel surface"]')!);
    await click(buttonWithText("Files"));
    expect(onAddFiles).toHaveBeenCalledOnce();
  });
});
