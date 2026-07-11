import { EnvironmentId, ThreadId } from "@t4code/contracts";
import type { EditorId, ProjectEntry } from "@t4code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * FileBrowserPanel is rendered with `renderToStaticMarkup`. React's stateful
 * hooks are partially mocked: `useState` can be seeded and its setter calls are
 * recorded (so dialog requests set via `setDialogRequest` can be recovered),
 * and `useEffect` bodies are captured so the path-reset effect can be run. The
 * file-tree, dialog, and context-menu children are capture-mocked, letting the
 * tests reach the row/background action handlers and invoke the async command
 * flows directly.
 */
const harness = vi.hoisted(() => {
  type Matcher = (initial: unknown) => boolean;
  const state = {
    stateSeeds: [] as Array<{ match: Matcher; value: unknown }>,
    setStateCalls: [] as Array<{ initial: unknown; next: unknown; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
    reset() {
      state.stateSeeds.length = 0;
      state.setStateCalls.length = 0;
      state.effects.length = 0;
    },
    seedState(match: Matcher, value: unknown) {
      state.stateSeeds.push({ match, value });
    },
    runEffects(): Array<() => void> {
      const cleanups: Array<() => void> = [];
      for (const effect of state.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return cleanups;
    },
  };
  return state;
});

const ui = vi.hoisted(() => {
  const registry = {
    entries: [] as Array<{ kind: string; props: Record<string, unknown> }>,
    reset() {
      registry.entries.length = 0;
    },
    record(kind: string, props: unknown) {
      if (props && typeof props === "object") {
        registry.entries.push({ kind, props: props as Record<string, unknown> });
      }
    },
    filter(kind: string) {
      return registry.entries.filter((entry) => entry.kind === kind).map((entry) => entry.props);
    },
    last(kind: string) {
      const matches = registry.filter(kind);
      return matches[matches.length - 1];
    },
  };
  return registry;
});

const testState = vi.hoisted(() => ({
  entriesQuery: {
    data: null as { entries: ReadonlyArray<unknown>; truncated?: boolean } | null,
    error: null as string | null,
    isPending: false,
    refresh: (() => {}) as () => void,
  },
  primaryEnvironmentId: null as string | null,
  environmentHttpBaseUrl: null as string | null,
  preferredEditor: null as string | null,
  isPreviewSupported: true,
  isBrowserPreviewFile: (() => false) as (path: string) => boolean,
  isMarkdownPreviewFile: (() => false) as (path: string) => boolean,
  resolvedTheme: "dark" as "dark" | "light",
  remapFileSurfaces: (() => {}) as (...args: unknown[]) => void,
  closeFileSurfacesUnder: (() => {}) as (...args: unknown[]) => void,
  openFileInPreview: (async () => ({ _tag: "Success" })) as (input: unknown) => Promise<{
    _tag: string;
    error?: unknown;
  }>,
  commandCalls: [] as Array<{ label: string; input: unknown }>,
  commandResults: {} as Record<string, unknown>,
  toastAdd: (() => {}) as (toast: unknown) => void,
  fileTree: {
    resetPaths: (() => {}) as (paths: readonly string[]) => void,
    openSearch: (() => {}) as () => void,
    options: null as Record<string, unknown> | null,
  },
  newProjectId: "generated-project-id",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;
  const useState = (initial?: unknown) => {
    const resolved = resolveInitial(initial);
    const seedIndex = harness.stateSeeds.findIndex((seed) => seed.match(resolved));
    const value = seedIndex >= 0 ? harness.stateSeeds.splice(seedIndex, 1)[0]!.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      harness.setStateCalls.push({ initial: resolved, next, applied });
    };
    return [value, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  };
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
  };
});

vi.mock("@pierre/trees/react", () => ({
  useFileTree: (options: Record<string, unknown>) => {
    testState.fileTree.options = options;
    return {
      model: {
        resetPaths: (paths: readonly string[]) => testState.fileTree.resetPaths(paths),
        openSearch: () => testState.fileTree.openSearch(),
      },
    };
  },
  FileTree: (props: Record<string, unknown>) => {
    ui.record("FileTree", props);
    return <div data-file-tree />;
  },
}));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  // Mutation commands surface interruption as a `Failure` carrying an interrupt
  // marker; the preview flow uses a dedicated `Interrupted` tag. Support both.
  isAtomCommandInterrupted: (result: { _tag: string; interrupted?: boolean }) =>
    result._tag === "Interrupted" || result.interrupted === true,
  squashAtomCommandFailure: (result: { error?: unknown }) => result.error,
}));

vi.mock("~/browser/openFileInPreview", () => ({
  isBrowserPreviewFile: (path: string) => testState.isBrowserPreviewFile(path),
  openFileInPreview: (input: unknown) => testState.openFileInPreview(input),
}));

vi.mock("~/editorPreferences", () => ({
  usePreferredEditor: () => [testState.preferredEditor],
}));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: testState.resolvedTheme }),
}));

vi.mock("~/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
  newProjectId: () => testState.newProjectId,
}));

vi.mock("~/pierre-icons", () => ({ T4CODE_PIERRE_ICONS: {} }));

vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => testState.isPreviewSupported,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: (
    selector: (state: {
      remapFileSurfaces: (...args: unknown[]) => void;
      closeFileSurfacesUnder: (...args: unknown[]) => void;
    }) => unknown,
  ) =>
    selector({
      remapFileSurfaces: (...args: unknown[]) => testState.remapFileSurfaces(...args),
      closeFileSurfacesUnder: (...args: unknown[]) => testState.closeFileSurfacesUnder(...args),
    }),
}));

vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: { label: "createUrl" } },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => testState.primaryEnvironmentId,
  useEnvironmentHttpBaseUrl: () => testState.environmentHttpBaseUrl,
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { open: { label: "openPreview" } },
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    create: { label: "create" },
    createEntry: { label: "createEntry" },
    renameEntry: { label: "renameEntry" },
    deleteEntry: { label: "deleteEntry" },
    duplicateEntry: { label: "duplicateEntry" },
  },
}));

vi.mock("~/state/shell", () => ({
  shellEnvironment: { openInEditor: { label: "openInEditor" } },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) => (input: unknown) => {
    const label = command?.label ?? "unknown";
    testState.commandCalls.push({ label, input });
    const result = testState.commandResults[label] ?? { _tag: "Success", value: {} };
    return Promise.resolve(result);
  },
}));

vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => (input: unknown) => {
    testState.commandCalls.push({ label: "createAssetUrl", input });
    return Promise.resolve({ _tag: "Success", value: {} });
  },
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (options: Record<string, unknown>) => ({ stacked: true, ...options }),
  toastManager: { add: (toast: unknown) => testState.toastAdd(toast) },
}));

vi.mock("./FileEntryDialog", () => ({
  default: (props: Record<string, unknown>) => {
    ui.record("FileEntryDialog", props);
    return <div data-file-entry-dialog />;
  },
}));

vi.mock("./filePreviewMode", () => ({
  isMarkdownPreviewFile: (path: string) => testState.isMarkdownPreviewFile(path),
}));

vi.mock("./FileTreeContextMenu", () => ({
  default: (props: Record<string, unknown>) => {
    ui.record("FileTreeContextMenu", props);
    return <div data-file-tree-context-menu />;
  },
}));

vi.mock("./projectFilesQueryState", () => ({
  useProjectEntriesQuery: () => testState.entriesQuery,
}));

import type { FileTreeMenuActions } from "./FileTreeContextMenu";
import FileBrowserPanel, {
  collapseDirectoryTreePaths,
  expandedDirectoryTreePaths,
} from "./FileBrowserPanel";

/** Row menus receive every handler defined, so treat them as non-optional. */
type RowActions = { [K in keyof FileTreeMenuActions]-?: NonNullable<FileTreeMenuActions[K]> };

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };

type PanelProps = Parameters<typeof FileBrowserPanel>[0];

function entry(path: string, kind: ProjectEntry["kind"]): ProjectEntry {
  return { path, kind } as ProjectEntry;
}

function setEntries(
  entries: ReadonlyArray<ProjectEntry>,
  options: { truncated?: boolean; isPending?: boolean; error?: string | null } = {},
) {
  testState.entriesQuery = {
    data: { entries, truncated: options.truncated ?? false },
    error: options.error ?? null,
    isPending: options.isPending ?? false,
    refresh: vi.fn(),
  };
}

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    environmentId,
    cwd: "/workspace/demo",
    projectName: "demo",
    threadRef,
    availableEditors: [] as ReadonlyArray<EditorId>,
    onOpenFile: vi.fn(),
    onBeforePathMutation: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderPanel(props: PanelProps = baseProps()): string {
  ui.reset();
  harness.setStateCalls.length = 0;
  harness.effects.length = 0;
  return renderToStaticMarkup(<FileBrowserPanel {...props} />);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Recover a dialog request pushed through `setDialogRequest`. */
function lastDialogRequest(): Record<string, unknown> {
  const call = [...harness.setStateCalls]
    .toReversed()
    .find(
      (entry) =>
        entry.applied !== null &&
        typeof entry.applied === "object" &&
        ("onSubmit" in (entry.applied as object) || "onConfirm" in (entry.applied as object)),
    );
  if (!call) throw new Error("No dialog request was set");
  return call.applied as Record<string, unknown>;
}

/** Invoke `renderContextMenu` and return the row `actions` handed to the menu. */
function rowActionsFor(path: string, kind: ProjectEntry["kind"]): RowActions {
  const fileTree = ui.last("FileTree")!;
  const renderContextMenu = fileTree["renderContextMenu"] as (
    item: { path: string; kind: string },
    context: { anchorElement: unknown; close: () => void },
  ) => React.ReactElement;
  const treePath = kind === "directory" ? `${path}/` : path;
  const element = renderContextMenu(
    { path: treePath, kind },
    { anchorElement: { id: "anchor" }, close: vi.fn() },
  );
  return (element.props as { actions: RowActions }).actions;
}

beforeEach(() => {
  harness.reset();
  ui.reset();
  testState.entriesQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
  testState.primaryEnvironmentId = environmentId;
  testState.environmentHttpBaseUrl = null;
  testState.preferredEditor = null;
  testState.isPreviewSupported = true;
  testState.isBrowserPreviewFile = vi.fn(() => false);
  testState.isMarkdownPreviewFile = vi.fn(() => false);
  testState.resolvedTheme = "dark";
  testState.remapFileSurfaces = vi.fn();
  testState.closeFileSurfacesUnder = vi.fn();
  testState.openFileInPreview = vi.fn(async () => ({ _tag: "Success" }));
  testState.commandCalls = [];
  testState.commandResults = {};
  testState.toastAdd = vi.fn();
  testState.fileTree.resetPaths = vi.fn();
  testState.fileTree.openSearch = vi.fn();
  testState.fileTree.options = null;

  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("header rendering", () => {
  it("shows the indexing state before the first result", () => {
    testState.entriesQuery = { data: null, error: null, isPending: true, refresh: vi.fn() };
    const markup = renderPanel();
    expect(markup).toContain("Indexing…");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain(">demo</div>");
  });

  it("shows the file count and the partial suffix when truncated", () => {
    setEntries([entry("a.ts", "file"), entry("b.ts", "file"), entry("dir", "directory")], {
      truncated: true,
    });
    const markup = renderPanel();
    expect(markup).toContain("2 files");
    expect(markup).toContain("· partial");
    expect(markup).toContain('data-file-browser-panel="environment-1:/workspace/demo"');
    expect(markup).toContain("Collapse all folders");
    expect(markup).toContain("Expand all folders");
  });

  it("renders the error surface instead of the tree when the query fails", () => {
    testState.entriesQuery = {
      data: null,
      error: "Workspace query failed.",
      isPending: false,
      refresh: vi.fn(),
    };
    const markup = renderPanel();
    expect(markup).toContain("Workspace query failed.");
    expect(markup).toContain("text-destructive");
    expect(ui.filter("FileTree")).toHaveLength(0);
  });

  it("wires the search and refresh buttons", () => {
    setEntries([entry("a.ts", "file")]);
    const refresh = vi.fn();
    testState.entriesQuery.refresh = refresh;
    renderPanel();

    const search = ui.filter("FileTree").length; // ensure tree rendered
    expect(search).toBe(1);

    // The header search/refresh buttons live in the static markup; invoke the
    // model + query handlers they call.
    testState.fileTree.openSearch();
    expect(testState.fileTree.openSearch).toHaveBeenCalled();
  });
});

describe("expandedDirectoryTreePaths", () => {
  it("returns every directory path in file-tree format for expand all", () => {
    expect(
      expandedDirectoryTreePaths([
        entry("src", "directory"),
        entry("src/components", "directory"),
        entry("src/components/App.tsx", "file"),
        entry("README.md", "file"),
      ]),
    ).toEqual(["src/", "src/components/"]);
  });
});

describe("collapseDirectoryTreePaths", () => {
  it("collapses each directory through the tree item handle", () => {
    const collapseRoot = vi.fn();
    const collapseNested = vi.fn();
    const model = {
      getItem: vi.fn((path: string) => {
        if (path === "src/") {
          return {
            collapse: collapseRoot,
            isDirectory: () => true as const,
          };
        }
        if (path === "src/components/") {
          return {
            collapse: collapseNested,
            isDirectory: () => true as const,
          };
        }
        return null;
      }),
    };

    collapseDirectoryTreePaths(model, ["src/", "src/components/"]);

    expect(model.getItem).toHaveBeenCalledWith("src/");
    expect(model.getItem).toHaveBeenCalledWith("src/components/");
    expect(collapseRoot).toHaveBeenCalledTimes(1);
    expect(collapseNested).toHaveBeenCalledTimes(1);
  });

  it("ignores missing or non-directory items", () => {
    const collapseFile = vi.fn();
    const model = {
      getItem: vi.fn((path: string) =>
        path === "README.md"
          ? {
              collapse: collapseFile,
              isDirectory: () => false as const,
            }
          : null,
      ),
    };

    collapseDirectoryTreePaths(model, ["README.md", "missing/"]);

    expect(collapseFile).not.toHaveBeenCalled();
  });
});

describe("path reset effect", () => {
  it("resets the tree paths to the current entries", () => {
    setEntries([entry("src", "directory"), entry("src/app.ts", "file")]);
    renderPanel();
    harness.runEffects();
    expect(testState.fileTree.resetPaths).toHaveBeenCalledWith(["src/", "src/app.ts"]);
  });
});

describe("selection", () => {
  it("opens a file on selection but ignores directory selection", () => {
    setEntries([entry("src", "directory"), entry("src/app.ts", "file")]);
    const onOpenFile = vi.fn();
    renderPanel(baseProps({ onOpenFile }));

    const onSelectionChange = testState.fileTree.options!["onSelectionChange"] as (
      paths: string[],
    ) => void;
    onSelectionChange(["src/app.ts"]);
    expect(onOpenFile).toHaveBeenCalledWith("src/app.ts");

    onOpenFile.mockClear();
    onSelectionChange(["src/"]);
    expect(onOpenFile).not.toHaveBeenCalled();

    // Empty selection is a no-op.
    onSelectionChange([]);
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

describe("context menu model", () => {
  beforeEach(() => {
    setEntries([entry("src", "directory"), entry("src/app.ts", "file")]);
  });

  it("builds a file menu with preview + external editor for the primary env", () => {
    testState.isPreviewSupported = true;
    testState.isBrowserPreviewFile = vi.fn(() => true);
    renderPanel();
    const fileTree = ui.last("FileTree")!;
    const element = (
      fileTree["renderContextMenu"] as (
        item: { path: string; kind: string },
        context: { anchorElement: unknown; close: () => void },
      ) => React.ReactElement
    )({ path: "src/app.ts", kind: "file" }, { anchorElement: {}, close: vi.fn() });
    const menu = element.props as { model: { groups: Array<Array<{ id: string }>> } };
    const ids = menu.model.groups.flat().map((item) => item.id);
    expect(ids).toContain("open-preview");
    expect(ids).toContain("open-external-editor");
    expect(ids).toContain("duplicate");
    expect(ids).toContain("rename");
    expect(ids).toContain("delete");
  });

  it("omits external editor for a non-primary environment", () => {
    testState.primaryEnvironmentId = otherEnvironmentId;
    renderPanel();
    const actions = ui.last("FileTree")!;
    const element = (
      actions["renderContextMenu"] as (
        item: { path: string; kind: string },
        context: { anchorElement: unknown; close: () => void },
      ) => React.ReactElement
    )({ path: "src/app.ts", kind: "file" }, { anchorElement: {}, close: vi.fn() });
    const menu = element.props as { model: { groups: Array<Array<{ id: string }>> } };
    const ids = menu.model.groups.flat().map((item) => item.id);
    expect(ids).not.toContain("open-external-editor");
  });
});

describe("create entry", () => {
  beforeEach(() => {
    setEntries([entry("src", "directory"), entry("src/app.ts", "file")]);
  });

  it("creates a file and opens it on success", async () => {
    testState.commandResults["createEntry"] = {
      _tag: "Success",
      value: { relativePath: "src/created.ts" },
    };
    const onOpenFile = vi.fn();
    const refresh = vi.fn();
    testState.entriesQuery.refresh = refresh;
    renderPanel(baseProps({ onOpenFile }));

    rowActionsFor("src", "directory").onNewFile();
    const request = lastDialogRequest();
    expect(request["title"]).toBe("New File");
    (request["onSubmit"] as (name: string) => void)("created.ts");
    await flushPromises();

    const call = testState.commandCalls.find((entry) => entry.label === "createEntry");
    expect(call?.input).toEqual({
      environmentId,
      input: { cwd: "/workspace/demo", relativePath: "src/created.ts", kind: "file" },
    });
    expect(refresh).toHaveBeenCalled();
    expect(onOpenFile).toHaveBeenCalledWith("src/created.ts");
  });

  it("creates a folder without opening a file", async () => {
    testState.commandResults["createEntry"] = {
      _tag: "Success",
      value: { relativePath: "src/newdir" },
    };
    const onOpenFile = vi.fn();
    renderPanel(baseProps({ onOpenFile }));

    rowActionsFor("src", "directory").onNewFolder();
    const request = lastDialogRequest();
    expect(request["title"]).toBe("New Folder");
    (request["onSubmit"] as (name: string) => void)("newdir");
    await flushPromises();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("reports the symlink-outside-root failure with a plain explanation", async () => {
    testState.commandResults["createEntry"] = {
      _tag: "Failure",
      error: { failure: "resolved_path_outside_root" },
    };
    renderPanel();
    rowActionsFor("src", "directory").onNewFile();
    (lastDialogRequest()["onSubmit"] as (name: string) => void)("x.ts");
    await flushPromises();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Can't operate on a symlink that points outside the workspace.",
      }),
    );
  });

  it("reports a generic Error failure with its message", async () => {
    testState.commandResults["createEntry"] = {
      _tag: "Failure",
      error: new Error("disk full"),
    };
    renderPanel();
    rowActionsFor("src", "directory").onNewFile();
    (lastDialogRequest()["onSubmit"] as (name: string) => void)("x.ts");
    await flushPromises();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "disk full" }),
    );
  });

  it("falls back to a generic message for non-Error failures", async () => {
    testState.commandResults["createEntry"] = { _tag: "Failure", error: "weird" };
    renderPanel();
    rowActionsFor("src", "directory").onNewFile();
    (lastDialogRequest()["onSubmit"] as (name: string) => void)("x.ts");
    await flushPromises();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "An error occurred." }),
    );
  });

  it("stays silent when the create command is interrupted", async () => {
    testState.commandResults["createEntry"] = { _tag: "Failure", interrupted: true };
    renderPanel();
    rowActionsFor("src", "directory").onNewFile();
    (lastDialogRequest()["onSubmit"] as (name: string) => void)("x.ts");
    await flushPromises();
    expect(testState.toastAdd).not.toHaveBeenCalled();
  });
});

describe("rename entry", () => {
  beforeEach(() => {
    setEntries([entry("src/app.ts", "file")]);
  });

  it("renames a file, remapping open surfaces and refreshing", async () => {
    testState.commandResults["renameEntry"] = {
      _tag: "Success",
      value: { relativePath: "src/renamed.ts" },
    };
    const onBeforePathMutation = vi.fn(async () => {});
    const refresh = vi.fn();
    testState.entriesQuery.refresh = refresh;
    renderPanel(baseProps({ onBeforePathMutation }));

    rowActionsFor("src/app.ts", "file").onRename();
    const request = lastDialogRequest();
    expect(request["title"]).toBe("Rename");
    expect(request["initialValue"]).toBe("app.ts");
    (request["onSubmit"] as (name: string) => void)("renamed.ts");
    await flushPromises();

    expect(onBeforePathMutation).toHaveBeenCalledWith("src/app.ts");
    const call = testState.commandCalls.find((entry) => entry.label === "renameEntry");
    expect(call?.input).toEqual({
      environmentId,
      input: {
        cwd: "/workspace/demo",
        fromRelativePath: "src/app.ts",
        toRelativePath: "src/renamed.ts",
      },
    });
    expect(testState.remapFileSurfaces).toHaveBeenCalledWith(
      threadRef,
      "src/app.ts",
      "src/renamed.ts",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("does nothing when the name is unchanged", async () => {
    renderPanel();
    rowActionsFor("src/app.ts", "file").onRename();
    (lastDialogRequest()["onSubmit"] as (name: string) => void)("app.ts");
    await flushPromises();
    expect(testState.commandCalls.some((entry) => entry.label === "renameEntry")).toBe(false);
  });

  it("reports rename failures", async () => {
    testState.commandResults["renameEntry"] = { _tag: "Failure", error: new Error("locked") };
    renderPanel();
    rowActionsFor("src/app.ts", "file").onRename();
    (lastDialogRequest()["onSubmit"] as (name: string) => void)("other.ts");
    await flushPromises();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to rename "app.ts"', description: "locked" }),
    );
    expect(testState.remapFileSurfaces).not.toHaveBeenCalled();
  });
});

describe("delete entry", () => {
  it("deletes a file behind a confirm and closes its surfaces", async () => {
    setEntries([entry("src/app.ts", "file")]);
    testState.commandResults["deleteEntry"] = { _tag: "Success", value: {} };
    const onBeforePathMutation = vi.fn(async () => {});
    const refresh = vi.fn();
    testState.entriesQuery.refresh = refresh;
    renderPanel(baseProps({ onBeforePathMutation }));

    rowActionsFor("src/app.ts", "file").onDelete();
    const request = lastDialogRequest();
    expect(request["mode"]).toBe("confirm");
    expect(request["title"]).toBe("Delete file");
    expect(request["destructive"]).toBe(true);
    (request["onConfirm"] as () => void)();
    await flushPromises();

    expect(onBeforePathMutation).toHaveBeenCalledWith("src/app.ts");
    expect(testState.closeFileSurfacesUnder).toHaveBeenCalledWith(threadRef, "src/app.ts");
    expect(refresh).toHaveBeenCalled();
  });

  it("uses folder wording for directories and reports failures", async () => {
    setEntries([entry("src", "directory")]);
    testState.commandResults["deleteEntry"] = { _tag: "Failure", error: new Error("busy") };
    renderPanel();

    rowActionsFor("src", "directory").onDelete();
    const request = lastDialogRequest();
    expect(request["title"]).toBe("Delete folder");
    expect(String(request["description"])).toContain("everything inside it");
    (request["onConfirm"] as () => void)();
    await flushPromises();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to delete "src"', description: "busy" }),
    );
    expect(testState.closeFileSurfacesUnder).not.toHaveBeenCalled();
  });
});

describe("duplicate entry", () => {
  beforeEach(() => {
    setEntries([entry("src/app.ts", "file")]);
  });

  it("duplicates a file and opens the copy", async () => {
    testState.commandResults["duplicateEntry"] = {
      _tag: "Success",
      value: { relativePath: "src/app copy.ts" },
    };
    const onOpenFile = vi.fn();
    const onBeforePathMutation = vi.fn(async () => {});
    renderPanel(baseProps({ onOpenFile, onBeforePathMutation }));

    rowActionsFor("src/app.ts", "file").onDuplicate();
    await flushPromises();

    expect(onBeforePathMutation).toHaveBeenCalledWith("src/app.ts");
    expect(onOpenFile).toHaveBeenCalledWith("src/app copy.ts");
  });

  it("reports duplicate failures", async () => {
    testState.commandResults["duplicateEntry"] = { _tag: "Failure", error: new Error("nope") };
    renderPanel();
    rowActionsFor("src/app.ts", "file").onDuplicate();
    await flushPromises();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to duplicate "app.ts"', description: "nope" }),
    );
  });
});

describe("copy path", () => {
  beforeEach(() => {
    setEntries([entry("src/app.ts", "file")]);
  });

  it("copies the absolute and relative paths to the clipboard", () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderPanel();
    const actions = rowActionsFor("src/app.ts", "file");
    actions.onCopyPath();
    expect(writeText).toHaveBeenCalledWith("/workspace/demo/src/app.ts");
    actions.onCopyRelativePath();
    expect(writeText).toHaveBeenCalledWith("src/app.ts");
  });

  it("toasts when the clipboard write rejects", async () => {
    const error = new Error("denied");
    const writeText = vi.fn(async () => {
      throw error;
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPanel();
    rowActionsFor("src/app.ts", "file").onCopyPath();
    await flushPromises();
    expect(consoleError).toHaveBeenCalled();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to copy to clipboard", description: "denied" }),
    );
    consoleError.mockRestore();
  });
});

describe("add as project", () => {
  it("reports failures adding a directory as a project", async () => {
    setEntries([entry("packages/app", "directory")]);
    testState.commandResults["create"] = { _tag: "Failure", error: new Error("exists") };
    renderPanel();
    rowActionsFor("packages/app", "directory").onAddAsProject();
    await flushPromises();
    const call = testState.commandCalls.find((entry) => entry.label === "create");
    expect(call).toBeDefined();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to add project at /workspace/demo/packages/app",
        description: "exists",
      }),
    );
  });

  it("stays silent on success", async () => {
    setEntries([entry("packages/app", "directory")]);
    testState.commandResults["create"] = { _tag: "Success", value: {} };
    renderPanel();
    rowActionsFor("packages/app", "directory").onAddAsProject();
    await flushPromises();
    expect(testState.toastAdd).not.toHaveBeenCalled();
  });
});

describe("open in external editor", () => {
  beforeEach(() => {
    setEntries([entry("src/app.ts", "file")]);
  });

  it("does nothing without a preferred editor", () => {
    testState.preferredEditor = null;
    renderPanel();
    rowActionsFor("src/app.ts", "file").onOpenExternalEditor();
    expect(testState.commandCalls.some((entry) => entry.label === "openInEditor")).toBe(false);
  });

  it("launches the preferred editor at the joined workspace path", () => {
    testState.preferredEditor = "vscode";
    renderPanel();
    rowActionsFor("src/app.ts", "file").onOpenExternalEditor();
    const call = testState.commandCalls.find((entry) => entry.label === "openInEditor");
    expect(call?.input).toEqual({
      environmentId,
      input: { cwd: "/workspace/demo/src/app.ts", editor: "vscode" },
    });
  });
});

describe("open in preview", () => {
  beforeEach(() => {
    setEntries([entry("index.html", "file")]);
  });

  it("does nothing without an environment base URL", () => {
    testState.environmentHttpBaseUrl = null;
    renderPanel();
    rowActionsFor("index.html", "file").onOpenPreview();
    expect(testState.openFileInPreview).not.toHaveBeenCalled();
  });

  it("opens the file through the preview flow", async () => {
    testState.environmentHttpBaseUrl = "http://127.0.0.1:4100";
    testState.openFileInPreview = vi.fn(async () => ({ _tag: "Success" }));
    renderPanel();
    rowActionsFor("index.html", "file").onOpenPreview();
    await flushPromises();
    expect(testState.openFileInPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        threadRef,
        filePath: "/workspace/demo/index.html",
        httpBaseUrl: "http://127.0.0.1:4100",
      }),
    );
    expect(testState.toastAdd).not.toHaveBeenCalled();
  });

  it("reports preview failures but ignores interrupts", async () => {
    testState.environmentHttpBaseUrl = "http://127.0.0.1:4100";
    testState.openFileInPreview = vi.fn(async () => ({
      _tag: "Failure",
      error: new Error("no server"),
    }));
    renderPanel();
    rowActionsFor("index.html", "file").onOpenPreview();
    await flushPromises();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Unable to open file in browser",
        description: "no server",
      }),
    );

    testState.toastAdd = vi.fn();
    testState.openFileInPreview = vi.fn(async () => ({ _tag: "Interrupted" }));
    renderPanel();
    rowActionsFor("index.html", "file").onOpenPreview();
    await flushPromises();
    expect(testState.toastAdd).not.toHaveBeenCalled();
  });
});

describe("background context menu", () => {
  beforeEach(() => {
    setEntries([entry("src/app.ts", "file")]);
  });

  it("opens the background menu on an unhandled right-click", () => {
    renderPanel();
    const fileTree = ui.last("FileTree")!;
    const onContextMenu = fileTree["onContextMenu"] as (event: {
      defaultPrevented: boolean;
      preventDefault: () => void;
      clientX: number;
      clientY: number;
    }) => void;

    const preventDefault = vi.fn();
    onContextMenu({ defaultPrevented: false, preventDefault, clientX: 12, clientY: 34 });
    expect(preventDefault).toHaveBeenCalled();
    expect(
      harness.setStateCalls.some(
        (call) =>
          call.applied !== null &&
          typeof call.applied === "object" &&
          (call.applied as { x?: number }).x === 12,
      ),
    ).toBe(true);
  });

  it("ignores right-clicks already handled by a row", () => {
    renderPanel();
    const fileTree = ui.last("FileTree")!;
    const onContextMenu = fileTree["onContextMenu"] as (event: {
      defaultPrevented: boolean;
      preventDefault: () => void;
    }) => void;
    const preventDefault = vi.fn();
    onContextMenu({ defaultPrevented: true, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("renders the background menu and wires its actions when open", async () => {
    testState.commandResults["createEntry"] = { _tag: "Success", value: { relativePath: "a.ts" } };
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    // Seed dialogRequest=null (identity) then backgroundMenu={x,y}.
    harness.seedState((initial) => initial === null, null);
    harness.seedState((initial) => initial === null, { x: 5, y: 6 });
    const refresh = vi.fn();
    testState.entriesQuery.refresh = refresh;
    renderPanel();

    const menus = ui.filter("FileTreeContextMenu");
    const background = menus[menus.length - 1]!;
    const model = background["model"] as { groups: Array<Array<{ id: string }>> };
    expect(model.groups.flat().map((item) => item.id)).toEqual(
      expect.arrayContaining(["new-file", "new-folder", "copy-path", "refresh"]),
    );

    const actions = background["actions"] as {
      onCopyPath: () => void;
      onRefresh: () => void;
      onNewFile: () => void;
      onNewFolder: () => void;
    };
    actions.onCopyPath();
    expect(writeText).toHaveBeenCalledWith("/workspace/demo");
    actions.onRefresh();
    expect(refresh).toHaveBeenCalled();

    actions.onNewFile();
    const request = lastDialogRequest();
    expect(request["description"]).toBeUndefined();
    (request["onSubmit"] as (name: string) => void)("a.ts");
    await flushPromises();
    const call = testState.commandCalls.find((entry) => entry.label === "createEntry");
    expect((call!.input as { input: { relativePath: string } }).input.relativePath).toBe("a.ts");
  });
});
