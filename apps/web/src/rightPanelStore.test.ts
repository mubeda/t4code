import { scopeThreadRef } from "@t4code/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t4code/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore", () => {
  it("drops the legacy singleton terminal surface during migration", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "terminal",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "terminal", kind: "terminal" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
        },
      },
    });
  });

  it("upgrades saved single-session terminal surfaces to split-capable surfaces", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "terminal:term-1",
            surfaces: [{ id: "terminal:term-1", kind: "terminal", resourceId: "term-1" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "terminal:term-1",
          surfaces: [
            {
              id: "terminal:term-1",
              kind: "terminal",
              resourceId: "term-1",
              terminalIds: ["term-1"],
              activeTerminalId: "term-1",
            },
          ],
        },
      },
    });
  });

  it("upgrades saved file surfaces with neutral reveal state", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [{ id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealLine: null,
              revealRequestId: 0,
            },
          ],
        },
      },
    });
  });

  it("open sets the active panel for a thread", () => {
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull();
  });

  it("opens a singleton source control surface", () => {
    useRightPanelStore.getState().open(refA, "sourceControl");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toContainEqual({ id: "sourceControl", kind: "sourceControl" });
    expect(state.activeSurfaceId).toBe("sourceControl");
    expect(state.isOpen).toBe(true);
  });

  it("opening a different kind keeps both surfaces and activates the new one", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
  });

  it("keeps files as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refA, "files");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });
  });

  it("replaces the standalone explorer with peer file surfaces", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it("updates line reveal requests when reopening a file surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 42);
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 87);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: 87,
          revealRequestId: 2,
        },
      ],
    });

    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 3,
        },
      ],
    });
  });

  it("removes persisted file surfaces when their workspace no longer exists", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().openFile(refA, "README.md");

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
    });

    useRightPanelStore.getState().openFile(refB, "conductor.json");
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("close hides the panel without clearing its selected surface", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().close(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
    });
  });

  it("toggles empty panel visibility without creating a surface", () => {
    useRightPanelStore.getState().toggleVisibility(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    });

    useRightPanelStore.getState().toggleVisibility(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("toggle hides the panel without discarding the active surface", () => {
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
    });
  });

  it("toggle to a different kind switches active", () => {
    useRightPanelStore.getState().toggle(refA, "preview");
    useRightPanelStore.getState().toggle(refA, "plan");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("plan");
  });

  it("removeThread clears persisted state", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().removeThread(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
  });

  it("close on never-opened thread is a no-op", () => {
    useRightPanelStore.getState().close(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("tracks one surface per browser session", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a", "browser:tab-b"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "browser:tab-b",
      kind: "preview",
      resourceId: "tab-b",
    });
  });

  it("tracks one surface per terminal session", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openTerminal(refA, "term-2");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([
      {
        id: "terminal:term-1",
        kind: "terminal",
        resourceId: "term-1",
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
      },
      {
        id: "terminal:term-2",
        kind: "terminal",
        resourceId: "term-2",
        terminalIds: ["term-2"],
        activeTerminalId: "term-2",
      },
    ]);
    expect(state.activeSurfaceId).toBe("terminal:term-2");
  });

  it("tracks split panes and the active pane within a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
    });

    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-2"],
      activeTerminalId: "term-2",
    });
  });

  it("tracks vertical layout for a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2", "vertical");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      splitDirection: "vertical",
    });
  });

  it("closing the final terminal pane removes its surface and closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing the final surface closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing other surfaces keeps the selected surface active", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeOtherSurfaces(refA, "file:src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-a",
      surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
    });
  });

  it("closing all surfaces closes the panel", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    useRightPanelStore.getState().closeAllSurfaces(refA);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("reconciles browser surfaces without deleting other surface kinds", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-b", "tab-c"]);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["terminal:term-1", "browser:tab-b", "browser:tab-c"]);
  });

  it("remaps a renamed file surface, preserving its reveal state and active selection", () => {
    useRightPanelStore.getState().openFile(refA, "src/old.ts", 12);
    useRightPanelStore.getState().remapFileSurfaces(refA, "src/old.ts", "src/new.ts");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/new.ts",
      surfaces: [
        {
          id: "file:src/new.ts",
          kind: "file",
          relativePath: "src/new.ts",
          revealLine: 12,
          revealRequestId: 1,
        },
      ],
    });
  });

  it("remaps every descendant surface when a directory is renamed", () => {
    useRightPanelStore.getState().openFile(refA, "src/a.ts");
    useRightPanelStore.getState().openFile(refA, "src/nested/b.ts");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().remapFileSurfaces(refA, "src", "lib");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "file:lib/a.ts",
      "file:lib/nested/b.ts",
      "plan",
    ]);
    expect(state.activeSurfaceId).toBe("plan");
  });

  it("rewrites the active surface id when a renamed directory contained it", () => {
    useRightPanelStore.getState().openFile(refA, "src/nested/b.ts");
    useRightPanelStore.getState().remapFileSurfaces(refA, "src", "lib");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "file:lib/nested/b.ts",
    );
  });

  it("leaves sibling surfaces that merely share a name prefix untouched when renaming", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "srcfoo/x.ts");
    useRightPanelStore.getState().remapFileSurfaces(refA, "src", "lib");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:lib/index.ts", "file:srcfoo/x.ts"]);
  });

  it("remap is a no-op when no file surface matches", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().remapFileSurfaces(refA, "src/index.ts", "src/renamed.ts");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
    });
  });

  it("closes the exact file surface and falls back to a neighbor", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().closeFileSurfacesUnder(refA, "src/index.ts");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a"]);
    expect(state.activeSurfaceId).toBe("browser:tab-a");
  });

  it("closes every descendant surface when a directory is deleted", () => {
    useRightPanelStore.getState().openFile(refA, "src/a.ts");
    useRightPanelStore.getState().openFile(refA, "src/nested/b.ts");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().closeFileSurfacesUnder(refA, "src");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["plan"]);
    expect(state.activeSurfaceId).toBe("plan");
  });

  it("leaves sibling surfaces sharing a prefix when deleting a directory", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "srcfoo/x.ts");
    useRightPanelStore.getState().closeFileSurfacesUnder(refA, "src");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:srcfoo/x.ts"]);
  });

  it("closes the panel when deleting removes the last surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().closeFileSurfacesUnder(refA, "src");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("normalizes malformed and partially upgraded persisted state", () => {
    expect(migratePersistedRightPanelState(null)).toEqual({ byThreadKey: {} });
    expect(migratePersistedRightPanelState({})).toEqual({ byThreadKey: {} });
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          invalid: null,
          files: {
            activeSurfaceId: "missing",
            surfaces: [
              {
                id: "file:a.ts",
                kind: "file",
                relativePath: "a.ts",
                revealLine: -4.8,
                revealRequestId: 3,
              },
              {
                id: "terminal:bad-id",
                kind: "terminal",
                resourceId: "other",
              },
              {
                id: "terminal:term-1",
                kind: "terminal",
                resourceId: "term-1",
                terminalIds: ["term-1", "term-1", 42],
                activeTerminalId: "missing",
              },
              {
                id: "terminal:term-2",
                kind: "terminal",
                resourceId: "term-2",
                terminalIds: [],
                activeTerminalId: "term-2",
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        invalid: { isOpen: false, activeSurfaceId: null, surfaces: [] },
        files: {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [
            {
              id: "file:a.ts",
              kind: "file",
              relativePath: "a.ts",
              revealLine: 1,
              revealRequestId: 3,
            },
            {
              id: "terminal:term-1",
              kind: "terminal",
              resourceId: "term-1",
              terminalIds: ["term-1"],
              activeTerminalId: "term-1",
            },
            {
              id: "terminal:term-2",
              kind: "terminal",
              resourceId: "term-2",
              terminalIds: ["term-2"],
              activeTerminalId: "term-2",
            },
          ],
        },
      },
    });
  });

  it("reuses preview placeholders and normalizes file reveal lines", () => {
    useRightPanelStore.getState().open(refA, "preview");
    useRightPanelStore.getState().open(refA, "preview");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(1);

    useRightPanelStore.getState().openBrowser(refA, null);
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/a.ts", Number.NaN);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ revealLine: null });
    useRightPanelStore.getState().openFile(refA, "src/a.ts", -2.9);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ revealLine: 1, revealRequestId: 2 });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.some(
        (surface) => surface.id === "browser:new",
      ),
    ).toBe(false);
  });

  it("ignores invalid terminal operations and preserves non-active panes", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2", "vertical");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useRightPanelStore.getState().splitTerminal(refA, "missing", "term-3");
    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "missing");
    useRightPanelStore.getState().closeTerminal(refA, "missing", "term-1");
    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-2");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1"],
      activeTerminalId: "term-1",
    });
  });

  it("treats invalid or already-satisfied surface closing operations as no-ops", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "a.ts");
    useRightPanelStore.getState().activateSurface(refA, "missing");
    useRightPanelStore.getState().closeSurface(refA, "missing");
    useRightPanelStore.getState().closeSurface(refA, "browser:tab-a");
    useRightPanelStore.getState().closeOtherSurfaces(refA, "missing");
    useRightPanelStore.getState().closeOtherSurfaces(refA, "file:a.ts");
    useRightPanelStore.getState().closeSurfacesToRight(refA, "missing");
    useRightPanelStore.getState().closeSurfacesToRight(refA, "file:a.ts");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "file:a.ts",
    );
    useRightPanelStore.getState().closeAllSurfaces(refB);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("reconciles empty browser and workspace states with deterministic fallbacks", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, []);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "plan",
    );
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-b"]);
    useRightPanelStore.getState().openFile(refA, "a.ts");
    useRightPanelStore.getState().reconcileFileSurfaces(refA, true);
    useRightPanelStore.getState().activateSurface(refA, "browser:tab-b");
    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-b",
    );
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false);
  });

  it("handles file collisions, missing deletes, and non-active directory deletes", () => {
    useRightPanelStore.getState().openFile(refA, "new/a.ts");
    useRightPanelStore.getState().openFile(refA, "old/a.ts");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().remapFileSurfaces(refA, "old", "new");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:new/a.ts", "plan"]);
    useRightPanelStore.getState().closeFileSurfacesUnder(refA, "missing");
    useRightPanelStore.getState().closeFileSurfacesUnder(refA, "new");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "plan",
    );
  });

  it("covers visibility no-ops, preview toggles, missing removal, and selectors", () => {
    useRightPanelStore.getState().show(refA);
    useRightPanelStore.getState().show(refA);
    useRightPanelStore.getState().close(refA);
    useRightPanelStore.getState().close(refA);
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().toggle(refA, "preview");
    useRightPanelStore.getState().toggle(refA, "preview");
    useRightPanelStore.getState().removeThread(refB);

    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(byThreadKey, null).surfaces).toEqual([]);
    expect(selectActiveRightPanel(byThreadKey, null)).toBeNull();
    expect(selectActiveRightPanelSurface(byThreadKey, null)).toBeNull();
    const threadKey = Object.keys(byThreadKey)[0]!;
    expect(
      selectActiveRightPanel(
        {
          [threadKey]: { isOpen: true, activeSurfaceId: "missing", surfaces: [] },
        },
        refA,
      ),
    ).toBeNull();
  });

  it("covers active migration and terminal, reconciliation, and selector fallbacks", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          saved: {
            activeSurfaceId: "terminal:term-1",
            surfaces: [
              {
                id: "terminal:term-1",
                kind: "terminal",
                resourceId: "term-1",
                terminalIds: ["term-1", "term-2"],
                activeTerminalId: "term-2",
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      byThreadKey: {
        saved: {
          isOpen: true,
          activeSurfaceId: "terminal:term-1",
          surfaces: [{ activeTerminalId: "term-2" }],
        },
      },
    });

    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-2");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "plan",
    );

    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "a.ts");
    useRightPanelStore.getState().activateSurface(refA, "plan");
    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "plan",
    );

    useRightPanelStore.setState({ byThreadKey: {} });
    useRightPanelStore.getState().open(refA, "preview");
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-b"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-b",
    );
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, []);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toBeNull();

    const threadKey = Object.keys(useRightPanelStore.getState().byThreadKey)[0]!;
    useRightPanelStore.setState({
      byThreadKey: {
        [threadKey]: {
          isOpen: true,
          activeSurfaceId: null,
          surfaces: [
            {
              id: "file:old.ts",
              kind: "file",
              relativePath: "old.ts",
              revealLine: null,
              revealRequestId: 0,
            },
          ],
        },
      },
    });
    useRightPanelStore.getState().remapFileSurfaces(refA, "old.ts", "new.ts");
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toBeNull();
  });
});
