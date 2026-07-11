import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t4code/contracts";
import { scopeThreadRef } from "@t4code/client-runtime/environment";
import { type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// ── Module mocks ────────────────────────────────────────────────────────────
// The drawer's `TerminalViewport` child wires xterm + Effect atom state at
// mount time (inside effects). Static server rendering never runs effects, so
// the mocks only need to satisfy the render-time hook calls.

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    readonly isMockTerminal = true;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    readonly isMockFitAddon = true;
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => undefined,
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => undefined,
}));

vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => async () => ({ _tag: "Success" }),
}));

vi.mock("../state/server", () => ({
  serverEnvironment: {
    configValueAtom: (_environmentId: unknown) => ({ atom: "server-config" }),
  },
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: { open: { atom: "preview-open" } },
}));

vi.mock("../state/terminal", () => ({
  terminalEnvironment: {
    write: { atom: "terminal-write" },
    resize: { atom: "terminal-resize" },
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));

vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: () => ({
    buffer: "",
    error: null,
    status: "running",
    version: 0,
  }),
}));

vi.mock("./preview/openTerminalLinkInPreview", () => ({
  openTerminalLinkInPreview: async () => undefined,
}));

// Base UI popovers are interaction-heavy; replace with static stand-ins that
// keep the trigger element (with its aria-label) and popup label text in the
// markup so assertions can target real behavior.
vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <span data-slot="popover-trigger">
      {render}
      {children}
    </span>
  ),
  PopoverPopup: ({ children }: { children?: ReactNode }) => (
    <span data-slot="popover-popup">{children}</span>
  ),
}));

import ThreadTerminalDrawer, {
  TerminalViewport,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-terminal-drawer");
const TEST_THREAD_ID = ThreadId.make("thread-terminal-drawer");
const TEST_THREAD_REF = scopeThreadRef(TEST_ENVIRONMENT_ID, TEST_THREAD_ID);
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

type DrawerProps = ComponentProps<typeof ThreadTerminalDrawer>;
type ViewportProps = ComponentProps<typeof TerminalViewport>;

function drawerProps(overrides: Partial<DrawerProps> = {}): DrawerProps {
  return {
    threadRef: TEST_THREAD_REF,
    threadId: TEST_THREAD_ID,
    cwd: "/repo",
    height: 220,
    terminalIds: ["term-1"],
    activeTerminalId: "term-1",
    terminalGroups: [],
    activeTerminalGroupId: "",
    focusRequestId: 0,
    onSplitTerminal: () => {},
    onSplitTerminalVertical: () => {},
    onNewTerminal: () => {},
    onActiveTerminalChange: () => {},
    onCloseTerminal: () => {},
    onHeightChange: () => {},
    onAddTerminalContext: () => {},
    keybindings: EMPTY_KEYBINDINGS,
    ...overrides,
  };
}

function viewportProps(overrides: Partial<ViewportProps> = {}): ViewportProps {
  return {
    threadRef: TEST_THREAD_REF,
    threadId: TEST_THREAD_ID,
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    cwd: "/repo",
    onSessionExited: () => {},
    onAddTerminalContext: () => {},
    focusRequestId: 0,
    autoFocus: false,
    resizeEpoch: 0,
    drawerHeight: 220,
    keybindings: EMPTY_KEYBINDINGS,
    ...overrides,
  };
}

describe("resolveTerminalSelectionActionPosition", () => {
  const bounds = { left: 100, top: 200, width: 400, height: 300 };

  it("anchors below the selection rect when one is available", () => {
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect: { right: 250, bottom: 320 },
      pointer: { x: 999, y: 999 },
      viewport: { width: 1200, height: 900 },
    });
    expect(position).toEqual({ x: 250, y: 324 });
  });

  it("falls back to the drawer's top-right corner without a selection or pointer", () => {
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect: null,
      pointer: null,
      viewport: { width: 1200, height: 900 },
    });
    expect(position).toEqual({ x: 100 + 400 - 140, y: 200 + 12 });
  });

  it("clamps a pointer position inside the drawer bounds", () => {
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect: null,
      pointer: { x: 5, y: 5000 },
      viewport: { width: 1200, height: 900 },
    });
    expect(position).toEqual({ x: bounds.left, y: bounds.top + bounds.height });
  });

  it("keeps the action inside the viewport with an 8px margin", () => {
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect: { right: 5000, bottom: 5000 },
      pointer: null,
      viewport: { width: 600, height: 500 },
    });
    expect(position).toEqual({ x: 600 - 8, y: 500 - 8 });
  });

  it("never positions above the 8px minimum", () => {
    const position = resolveTerminalSelectionActionPosition({
      bounds: { left: -50, top: -50, width: 10, height: 10 },
      selectionRect: { right: -100, bottom: -100 },
      pointer: null,
      viewport: { width: 300, height: 300 },
    });
    expect(position).toEqual({ x: 8, y: 8 });
  });

  it("derives a fallback viewport from the drawer bounds when window is unavailable", () => {
    // In this node test environment `window` is undefined, so the fallback
    // viewport is the drawer's bottom-right corner plus an 8px margin.
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect: { right: 5000, bottom: 5000 },
      pointer: null,
    });
    expect(position).toEqual({
      x: bounds.left + bounds.width + 8 - 8,
      y: bounds.top + bounds.height + 8 - 8,
    });
  });

  it("reads the viewport from window when one exists and none is passed", () => {
    vi.stubGlobal("window", {
      innerWidth: 320,
      innerHeight: 240,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    try {
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect: { right: 5000, bottom: 5000 },
        pointer: null,
      });
      expect(position).toEqual({ x: 320 - 8, y: 240 - 8 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("terminalSelectionActionDelayForClickCount", () => {
  it("shows the action immediately for single clicks", () => {
    expect(terminalSelectionActionDelayForClickCount(0)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
  });

  it("delays the action for double and triple clicks", () => {
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });
});

describe("shouldHandleTerminalSelectionMouseUp", () => {
  it("handles only primary-button releases of an active selection gesture", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(true, 2)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
  });
});

describe("TerminalViewport", () => {
  it("renders the terminal mount container", () => {
    const markup = renderToStaticMarkup(<TerminalViewport {...viewportProps()} />);
    expect(markup).toContain("overflow-hidden");
    expect(markup).toContain("bg-background");
  });

  it("renders with a worktree path and runtime env", () => {
    const markup = renderToStaticMarkup(
      <TerminalViewport
        {...viewportProps({
          worktreePath: "/repo/worktrees/feature",
          runtimeEnv: { ZED_HINT: "1", PATH_HINT: "2", "": "ignored" },
        })}
      />,
    );
    expect(markup).toContain("<div");
  });

  it("renders with a null worktree path", () => {
    const markup = renderToStaticMarkup(
      <TerminalViewport {...viewportProps({ worktreePath: null })} />,
    );
    expect(markup).toContain("<div");
  });
});

describe("ThreadTerminalDrawer empty state", () => {
  it("renders the empty state with a new-terminal action in drawer mode", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({ terminalIds: [], activeTerminalId: "", newShortcutLabel: "Ctrl+T" })}
      />,
    );
    expect(markup).toContain("No terminal sessions for this thread yet.");
    expect(markup).toContain("New Terminal (Ctrl+T)");
    expect(markup).toContain('data-terminal-owner="drawer"');
    expect(markup).toContain("cursor-row-resize");
    expect(markup).toContain("height:220px");
  });

  it("omits the resize handle and inline height in panel mode", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer {...drawerProps({ mode: "panel", terminalIds: [] })} />,
    );
    expect(markup).toContain('data-terminal-owner="right-panel"');
    expect(markup).not.toContain("cursor-row-resize");
    expect(markup).not.toContain("height:220px");
    expect(markup).toContain("New Terminal");
  });

  it("treats blank-only terminal ids as an empty terminal list", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer {...drawerProps({ terminalIds: ["  ", ""] })} />,
    );
    expect(markup).toContain("No terminal sessions for this thread yet.");
  });
});

describe("ThreadTerminalDrawer single terminal", () => {
  it("renders the floating action strip without a sidebar", () => {
    const markup = renderToStaticMarkup(<ThreadTerminalDrawer {...drawerProps()} />);
    expect(markup).toContain('aria-label="Split Terminal Horizontally"');
    expect(markup).toContain('aria-label="Split Terminal Vertically"');
    expect(markup).toContain('aria-label="New Terminal"');
    expect(markup).toContain('aria-label="Close Terminal"');
    expect(markup).not.toContain("Group 1");
  });

  it("clamps the drawer height between the minimum and the default maximum", () => {
    // Without a window the max drawer height falls back to the 280px default.
    const tall = renderToStaticMarkup(<ThreadTerminalDrawer {...drawerProps({ height: 5000 })} />);
    expect(tall).toContain("height:280px");

    const short = renderToStaticMarkup(<ThreadTerminalDrawer {...drawerProps({ height: 10 })} />);
    expect(short).toContain("height:180px");

    const invalid = renderToStaticMarkup(
      <ThreadTerminalDrawer {...drawerProps({ height: Number.NaN })} />,
    );
    expect(invalid).toContain("height:280px");
  });

  it("derives the max drawer height from the window when one exists", () => {
    vi.stubGlobal("window", {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    try {
      const markup = renderToStaticMarkup(
        <ThreadTerminalDrawer {...drawerProps({ height: 5000 })} />,
      );
      // 75% of the 768px window height.
      expect(markup).toContain("height:576px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("includes shortcut labels in the action tooltips when provided", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          splitShortcutLabel: "Ctrl+Shift+H",
          splitVerticalShortcutLabel: "Ctrl+Shift+V",
          newShortcutLabel: "Ctrl+T",
          closeShortcutLabel: "Ctrl+W",
        })}
      />,
    );
    expect(markup).toContain("Split Terminal Horizontally (Ctrl+Shift+H)");
    expect(markup).toContain("Split Terminal Vertically (Ctrl+Shift+V)");
    expect(markup).toContain("New Terminal (Ctrl+T)");
    expect(markup).toContain("Close Terminal (Ctrl+W)");
  });

  it("deduplicates and trims terminal ids before rendering", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({ terminalIds: [" term-1 ", "term-1", ""], activeTerminalId: "term-1" })}
      />,
    );
    // A single surviving terminal renders without the multi-terminal sidebar.
    expect(markup).not.toContain("Group 1");
    expect(markup).toContain('aria-label="Close Terminal"');
  });
});

describe("ThreadTerminalDrawer split groups", () => {
  const twoInOneGroup = {
    terminalIds: ["term-1", "term-2"],
    activeTerminalId: "term-1",
    terminalGroups: [{ id: "group-a", terminalIds: ["term-1", "term-2"] }],
    activeTerminalGroupId: "group-a",
  } satisfies Partial<DrawerProps>;

  it("renders a horizontal split grid for a two-terminal group", () => {
    const markup = renderToStaticMarkup(<ThreadTerminalDrawer {...drawerProps(twoInOneGroup)} />);
    expect(markup).toContain("grid-template-columns:repeat(2, minmax(0, 1fr))");
    expect(markup).not.toContain("grid-template-rows");
  });

  it("renders a vertical split grid when the group direction is vertical", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          ...twoInOneGroup,
          terminalGroups: [
            { id: "group-a", terminalIds: ["term-1", "term-2"], splitDirection: "vertical" },
          ],
        })}
      />,
    );
    expect(markup).toContain("grid-template-rows:repeat(2, minmax(0, 1fr))");
  });

  it("disables split actions at the per-group terminal limit", () => {
    const ids = ["term-1", "term-2", "term-3", "term-4"];
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ids,
          activeTerminalId: "term-1",
          terminalGroups: [{ id: "group-a", terminalIds: ids }],
          activeTerminalGroupId: "group-a",
        })}
      />,
    );
    expect(markup).toContain("Split Terminal Horizontally (max 4 per group)");
    expect(markup).toContain("Split Terminal Vertically (max 4 per group)");
    expect(markup).toContain("cursor-not-allowed");
  });

  it("shows group headers when multiple groups exist", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2"],
          activeTerminalId: "term-2",
          terminalGroups: [
            { id: "group-a", terminalIds: ["term-1"] },
            { id: "group-b", terminalIds: ["term-2"] },
          ],
          activeTerminalGroupId: "group-b",
        })}
      />,
    );
    expect(markup).toContain("Group 1");
    expect(markup).toContain("Group 2");
    expect(markup).toContain("Terminal 1");
    expect(markup).toContain("Terminal 2");
  });

  it("sanitizes group definitions: blanks, duplicates, unknown and reassigned ids", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2", "term-3"],
          activeTerminalId: "term-2",
          terminalGroups: [
            // Group with only unknown/blank terminals is dropped entirely.
            { id: "ghost", terminalIds: ["missing", " ", ""] },
            // Blank group id gets a generated one; duplicate ids inside the
            // group collapse to a single entry.
            { id: "  ", terminalIds: ["term-1", "term-1"] },
            // A terminal already assigned above cannot be claimed again.
            { id: "claimed", terminalIds: ["term-1", "term-2"] },
          ],
          activeTerminalGroupId: "claimed",
        })}
      />,
    );
    // term-3 is unassigned and gets its own trailing group: three headers.
    expect(markup).toContain("Group 1");
    expect(markup).toContain("Group 2");
    expect(markup).toContain("Group 3");
    expect(markup).toContain("Terminal 3");
  });

  it("assigns unique group ids when duplicate group ids collide", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2"],
          activeTerminalId: "term-1",
          terminalGroups: [
            { id: "dup", terminalIds: ["term-1"] },
            { id: "dup", terminalIds: ["term-2"] },
          ],
          activeTerminalGroupId: "dup",
        })}
      />,
    );
    expect(markup).toContain("Group 1");
    expect(markup).toContain("Group 2");
  });

  it("keeps probing suffixes when the deduplicated group id is also taken", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2", "term-3"],
          activeTerminalId: "term-1",
          terminalGroups: [
            { id: "dup", terminalIds: ["term-1"] },
            { id: "dup-2", terminalIds: ["term-2"] },
            // Collides with "dup", then with the existing "dup-2" → "dup-3".
            { id: "dup", terminalIds: ["term-3"] },
          ],
          activeTerminalGroupId: "dup",
        })}
      />,
    );
    expect(markup).toContain("Group 1");
    expect(markup).toContain("Group 2");
    expect(markup).toContain("Group 3");
  });

  it("falls back to the first terminal when the active id is unknown", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2"],
          activeTerminalId: "missing",
          terminalGroups: [
            { id: "group-a", terminalIds: ["term-1"] },
            { id: "group-b", terminalIds: ["term-2"] },
          ],
          activeTerminalGroupId: "missing-group",
          closeShortcutLabel: "Ctrl+W",
        })}
      />,
    );
    // The resolved active terminal (term-1) carries the close shortcut label.
    expect(markup).toContain("Close Terminal 1 (Ctrl+W)");
    expect(markup).toContain("Close Terminal 2");
    expect(markup).not.toContain("Close Terminal 2 (Ctrl+W)");
  });
});

describe("ThreadTerminalDrawer sidebar labels", () => {
  it("prefers server-provided labels over derived terminal labels", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "custom-shell"],
          activeTerminalId: "term-1",
          terminalLabelsById: new Map([["custom-shell", "vitest watch"]]),
        })}
      />,
    );
    expect(markup).toContain("Terminal 1");
    expect(markup).toContain("vitest watch");
    expect(markup).toContain('aria-label="Close vitest watch"');
  });

  it("uses per-terminal launch locations when the server knows the session", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2"],
          activeTerminalId: "term-2",
          runtimeEnv: { FALLBACK: "1" },
          worktreePath: "/repo/worktrees/default",
          terminalLaunchLocationsById: new Map([
            [
              "term-2",
              {
                cwd: "/repo/worktrees/feature",
                worktreePath: "/repo/worktrees/feature",
                runtimeEnv: { FEATURE: "1" },
              },
            ],
          ]),
        })}
      />,
    );
    // Both terminals render sidebar rows; the active one is highlighted.
    expect(markup).toContain("Terminal 1");
    expect(markup).toContain("Terminal 2");
    expect(markup).toContain("bg-accent");
  });
});
