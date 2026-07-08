import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface QueryView {
  data: unknown;
  error: string | null;
  isPending: boolean;
  refresh: () => void;
}

const h = vi.hoisted(() => {
  const emptyView: QueryView = { data: null, error: null, isPending: false, refresh: () => {} };
  return {
    emptyView,
    params: {} as Record<string, string | ReadonlyArray<string> | undefined>,
    routerPush: [] as Array<unknown>,
    selectedThread: null as unknown,
    selectedThreadProject: null as unknown,
    selectedThreadCwd: null as string | null,
    entriesView: { ...emptyView } as QueryView,
    fileView: { ...emptyView } as QueryView,
    assetUrl: null as string | null,
    pressables: [] as Array<Record<string, unknown>>,
    scrollViews: [] as Array<Record<string, unknown>>,
    toolbarButtons: [] as Array<Record<string, unknown>>,
    screenOptions: [] as Array<Record<string, unknown>>,
    copyButtons: [] as Array<Record<string, unknown>>,
    fileTreeProps: [] as Array<Record<string, unknown>>,
    listEntriesArgs: [] as Array<unknown>,
    readFileArgs: [] as Array<unknown>,
    assetUrlCalls: [] as Array<unknown>,
    externalUrlCalls: [] as Array<unknown>,
  };
});

vi.mock("expo-router", () => ({
  useRouter: () => ({
    push: (target: unknown) => {
      h.routerPush.push(target);
    },
  }),
  useLocalSearchParams: () => h.params,
}));

vi.mock("expo-router/stack", () => {
  const Stack = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  Stack.Screen = (props: { readonly options?: Record<string, unknown> }) => {
    h.screenOptions.push(props.options ?? {});
    return null;
  };
  const Toolbar = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  Toolbar.Button = (props: Record<string, unknown>) => {
    h.toolbarButtons.push(props);
    return <button type="button" />;
  };
  Toolbar.SearchBarSlot = () => null;
  Stack.Toolbar = Toolbar;
  return { default: Stack };
});

vi.mock("expo-symbols", () => ({
  SymbolView: (props: { readonly name: string }) => <i data-symbol={props.name} />,
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => <i data-activity-indicator="true" />,
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.pressables.push(props);
    return <button type="button">{props.children}</button>;
  },
  ScrollView: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.scrollViews.push(props);
    return <div>{props.children}</div>;
  },
  Text: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));

vi.mock("react-native-svg", () => ({
  default: (props: { readonly children?: ReactNode }) => <svg>{props.children}</svg>,
  Defs: (props: { readonly children?: ReactNode }) => <defs>{props.children}</defs>,
  LinearGradient: (props: { readonly children?: ReactNode; readonly id?: string }) => (
    <g data-gradient-id={props.id}>{props.children}</g>
  ),
  Rect: (props: { readonly fill?: string }) => <rect data-fill={props.fill} />,
  Stop: () => <stop />,
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
}));

vi.mock("../../components/CopyTextButton", () => ({
  CopyTextButton: (props: Record<string, unknown>) => {
    h.copyButtons.push(props);
    return <button data-copy="true" type="button" />;
  },
}));

vi.mock("../../components/EmptyState", () => ({
  EmptyState: (props: { readonly title: string; readonly detail?: string }) => (
    <div data-empty-state="true">
      {props.title}::{props.detail ?? ""}
    </div>
  ),
}));

vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: (props: { readonly message: string }) => (
    <div data-loading="true">{props.message}</div>
  ),
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: () => "#123456",
}));

vi.mock("../../lib/openExternalUrl", () => ({
  tryOpenExternalUrl: (url: string, source: string) => {
    h.externalUrlCalls.push({ url, source });
    return Promise.resolve(true);
  },
}));

vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: h.selectedThread,
    selectedThreadProject: h.selectedThreadProject,
  }),
}));

vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: h.selectedThreadCwd }),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { readonly kind?: string; readonly args?: unknown } | null) => {
    if (!atom) {
      return h.emptyView;
    }
    if (atom.kind === "listEntries") {
      h.listEntriesArgs.push(atom.args);
      return h.entriesView;
    }
    if (atom.kind === "readFile") {
      h.readFileArgs.push(atom.args);
      return h.fileView;
    }
    return h.emptyView;
  },
}));

vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    listEntries: (args: unknown) => ({ kind: "listEntries", args }),
    readFile: (args: unknown) => ({ kind: "readFile", args }),
  },
}));

vi.mock("../review/ReviewHighlighterProvider", () => ({
  ReviewHighlighterProvider: (props: { readonly children?: ReactNode }) => (
    <div data-review-provider="true">{props.children}</div>
  ),
}));

vi.mock("./FileMarkdownPreview", () => ({
  FileMarkdownPreview: (props: { readonly markdown: string }) => (
    <div data-markdown-preview={props.markdown} />
  ),
}));

vi.mock("./FileTreeBrowser", () => ({
  FileTreeBrowser: (props: Record<string, unknown>) => {
    h.fileTreeProps.push(props);
    return <div data-file-tree="true" />;
  },
}));

vi.mock("./SourceFileSurface", () => ({
  SourceFileSurface: (props: {
    readonly path: string;
    readonly contents: string;
    readonly initialLine: number | null;
  }) => <div data-source-surface={props.path} data-initial-line={String(props.initialLine)} />,
}));

vi.mock("./WorkspaceFileImagePreview", () => ({
  WorkspaceFileImagePreview: (props: {
    readonly uri: string | null;
    readonly accessibilityLabel: string;
  }) => <div data-image-preview={String(props.uri)} data-label={props.accessibilityLabel} />,
}));

vi.mock("./WorkspaceFileWebPreview", () => ({
  WorkspaceFileWebPreview: (props: { readonly uri: string | null }) => (
    <div data-web-preview={String(props.uri)} />
  ),
}));

vi.mock("./workspaceFileAssetUrl", () => ({
  useWorkspaceFileAssetUrl: (input: unknown) => {
    h.assetUrlCalls.push(input);
    return h.assetUrl;
  },
}));

import { ThreadFileScreen, ThreadFilesTreeScreen } from "./ThreadFilesRouteScreen";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const ENV = "env-1";
const THREAD = "thread-1";

function render(element: ReactElement): string {
  h.pressables.length = 0;
  h.scrollViews.length = 0;
  h.toolbarButtons.length = 0;
  h.screenOptions.length = 0;
  h.copyButtons.length = 0;
  h.fileTreeProps.length = 0;
  h.listEntriesArgs.length = 0;
  h.readFileArgs.length = 0;
  h.assetUrlCalls.length = 0;
  return renderToStaticMarkup(element);
}

function pressByLabel(label: string): void {
  const pressable = h.pressables.find((entry) => entry.accessibilityLabel === label);
  if (!pressable || typeof pressable.onPress !== "function") {
    throw new Error(`no pressable with accessibilityLabel "${label}"`);
  }
  (pressable.onPress as () => void)();
}

beforeEach(() => {
  h.params = {};
  h.routerPush.length = 0;
  h.selectedThread = null;
  h.selectedThreadProject = null;
  h.selectedThreadCwd = null;
  h.entriesView = { ...h.emptyView };
  h.fileView = { ...h.emptyView };
  h.assetUrl = null;
  h.externalUrlCalls.length = 0;
  delete process.env.EXPO_OS;
});

afterEach(() => {
  delete process.env.EXPO_OS;
});

describe("ThreadFilesTreeScreen", () => {
  it("shows a loading screen while the thread selection is hydrating", () => {
    h.params = { environmentId: ENV, threadId: THREAD };
    const markup = render(<ThreadFilesTreeScreen />);
    expect(markup).toContain("Opening files...");
  });

  it("shows a loading screen when the thread id route param is missing", () => {
    h.params = { environmentId: ENV };
    h.selectedThread = { environmentId: ENV };
    h.selectedThreadProject = { title: "Repo", workspaceRoot: "/repo" };
    const markup = render(<ThreadFilesTreeScreen />);
    expect(markup).toContain("Opening files...");
  });

  it("shows the unavailable state when there is no workspace path", () => {
    h.params = { environmentId: ENV, threadId: THREAD };
    h.selectedThread = { environmentId: ENV };
    h.selectedThreadProject = { title: "Repo" };
    h.selectedThreadCwd = null;
    const markup = render(<ThreadFilesTreeScreen />);
    expect(markup).toContain("Files unavailable");
    expect(markup).toContain("This thread does not have an active workspace path.");
  });

  it("lists file entries and navigates when a file is selected", () => {
    h.params = { environmentId: ENV, threadId: THREAD };
    h.selectedThread = { environmentId: ENV };
    h.selectedThreadProject = { title: "Repo", workspaceRoot: "/repo" };
    h.entriesView = {
      ...h.emptyView,
      data: { entries: [{ name: "a.ts", path: "a.ts" }] },
    };

    const markup = render(<ThreadFilesTreeScreen />);
    expect(markup).toContain('data-file-tree="true"');
    expect(h.listEntriesArgs).toEqual([{ environmentId: ENV, input: { cwd: "/repo" } }]);

    const treeProps = h.fileTreeProps[0];
    expect(treeProps?.entries).toEqual([{ name: "a.ts", path: "a.ts" }]);
    (treeProps!.onSelectFile as (path: string) => void)("src/a.ts");
    const pushed = h.routerPush[0] as { pathname: string; params: Record<string, unknown> };
    expect(pushed.pathname).toBe("/threads/[environmentId]/[threadId]/files/[...path]");
    expect(pushed.params).toMatchObject({
      environmentId: ENV,
      threadId: THREAD,
      path: ["src", "a.ts"],
    });
  });

  it("wires the refresh button and search bar options and renders the header title", () => {
    h.params = { environmentId: ENV, threadId: THREAD };
    h.selectedThread = { environmentId: ENV };
    h.selectedThreadProject = { title: "My Project", workspaceRoot: "/repo" };
    process.env.EXPO_OS = "ios";

    let refreshed = 0;
    h.entriesView = {
      ...h.emptyView,
      refresh: () => {
        refreshed += 1;
      },
    };

    const markup = render(<ThreadFilesTreeScreen />);

    const refreshButton = h.toolbarButtons.find(
      (button) => button.accessibilityLabel === "Refresh files",
    );
    (refreshButton!.onPress as () => void)();
    expect(refreshed).toBe(1);

    const options = h.screenOptions.find((entry) => entry.headerSearchBarOptions);
    const searchOptions = options?.headerSearchBarOptions as {
      onChangeText: (event: { nativeEvent: { text: string } }) => void;
      onCancelButtonPress: () => void;
    };
    searchOptions.onChangeText({ nativeEvent: { text: "query" } });
    searchOptions.onCancelButtonPress();

    const headerTitle = options?.headerTitle as () => ReactElement;
    const titleMarkup = renderToStaticMarkup(headerTitle());
    expect(titleMarkup).toContain("Files");
    expect(titleMarkup).toContain("My Project");

    // process.env.EXPO_OS === "ios" renders the bottom fade svg gradient
    expect(markup).toContain('data-gradient-id="files-toolbar-bottom-fade"');
  });

  it("falls back to the selected thread environment and default project name", () => {
    h.params = { threadId: THREAD };
    h.selectedThread = { environmentId: ENV };
    h.selectedThreadProject = null;
    h.selectedThreadCwd = "/worktree";

    const markup = render(<ThreadFilesTreeScreen />);
    expect(markup).toContain('data-file-tree="true"');
    expect(h.listEntriesArgs).toEqual([{ environmentId: ENV, input: { cwd: "/worktree" } }]);

    const options = h.screenOptions.find((entry) => entry.headerTitle);
    const headerTitle = options?.headerTitle as () => ReactElement;
    expect(renderToStaticMarkup(headerTitle())).toContain("Files");
  });
});

describe("ThreadFileScreen", () => {
  function setupWorkspace(overrides: { readonly workspaceRoot?: string | null } = {}) {
    h.selectedThread = { environmentId: ENV };
    h.selectedThreadProject = { title: "Repo", workspaceRoot: overrides.workspaceRoot ?? "/repo" };
  }

  it("shows a loading screen while hydrating", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "a.ts" };
    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain("Opening file...");
  });

  it("shows the unavailable state when there is no workspace path", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "a.ts" };
    h.selectedThread = { environmentId: ENV };
    h.selectedThreadProject = { title: "Repo" };
    h.selectedThreadCwd = null;
    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain("Files unavailable");
  });

  it("shows an invalid file state when the path param is empty", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "   " };
    setupWorkspace();
    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain("This file path is invalid.");
  });

  it("renders a source file with its target line and refresh handler", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: ["src", "a.ts"], line: "12" };
    setupWorkspace();
    let refreshed = 0;
    h.fileView = {
      ...h.emptyView,
      data: { contents: "const a = 1;", truncated: false },
      refresh: () => {
        refreshed += 1;
      },
    };

    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain('data-source-surface="src/a.ts"');
    expect(markup).toContain('data-initial-line="12"');
    expect(h.readFileArgs).toEqual([
      { environmentId: ENV, input: { cwd: "/repo", relativePath: "src/a.ts" } },
    ]);
    // no mode selector for a plain source file
    expect(markup).not.toContain(">Preview<");

    const refreshButton = h.toolbarButtons[0];
    (refreshButton!.onPress as () => void)();
    expect(refreshed).toBe(1);
  });

  it("shows the error state when the file cannot be read", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "a.ts" };
    setupWorkspace();
    h.fileView = { ...h.emptyView, error: "boom", data: null };
    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain("File unavailable");
    expect(markup).toContain("boom");
  });

  it("shows the loading spinner while file contents are pending", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "a.ts" };
    setupWorkspace();
    h.fileView = { ...h.emptyView, data: null };
    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain("Loading file...");
    expect(markup).toContain("data-activity-indicator");
  });

  it("shows the partial-file banner for truncated contents", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "a.ts" };
    setupWorkspace();
    h.fileView = { ...h.emptyView, data: { contents: "partial", truncated: true } };
    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain("Partial file");
    expect(markup).toContain('data-source-surface="a.ts"');
  });

  it("renders a markdown file in source mode with a mode selector", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "README.md" };
    setupWorkspace();
    h.fileView = { ...h.emptyView, data: { contents: "# Title", truncated: false } };

    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain(">Preview<");
    expect(markup).toContain(">Source<");
    // markdown is not a browser file, so no safari button is shown
    expect(
      h.pressables.some((entry) => entry.accessibilityLabel === "Open preview in Safari"),
    ).toBe(false);
    // default mode is source for markdown
    expect(markup).toContain('data-source-surface="README.md"');

    // invoking a mode button runs the setModeOverride handler body
    const modeButton = h.pressables.find(
      (entry) =>
        entry.accessibilityRole === "button" &&
        (entry.accessibilityState as { selected?: boolean } | undefined)?.selected !== undefined,
    );
    (modeButton!.onPress as () => void)();
  });

  it("renders a browser file preview with a working safari button", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "index.html" };
    setupWorkspace();
    h.assetUrl = "https://example.com/index.html";

    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain('data-web-preview="https://example.com/index.html"');
    // browser preview needs no file contents
    expect(h.readFileArgs).toEqual([]);

    pressByLabel("Open preview in Safari");
    expect(h.externalUrlCalls).toEqual([
      { url: "https://example.com/index.html", source: "file-preview" },
    ]);

    // refresh on a browser preview bumps the preview revision instead of refetching
    const refreshButton = h.toolbarButtons[0];
    (refreshButton!.onPress as () => void)();
    expect(h.readFileArgs).toEqual([]);
  });

  it("disables the safari button when no preview url is available", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "index.html" };
    setupWorkspace();
    h.assetUrl = null;

    render(<ThreadFileScreen />);
    pressByLabel("Open preview in Safari");
    expect(h.externalUrlCalls).toEqual([]);
  });

  it("renders a raster image preview without a mode selector", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "logo.png" };
    setupWorkspace();
    h.assetUrl = "https://example.com/logo.png";

    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain('data-image-preview="https://example.com/logo.png"');
    expect(markup).toContain('data-label="logo.png"');
    expect(markup).not.toContain(">Preview<");
  });

  it("renders an svg image through the web preview", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "icon.svg" };
    setupWorkspace();
    h.assetUrl = "https://example.com/icon.svg";

    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain('data-web-preview="https://example.com/icon.svg"');
    expect(markup).not.toContain(">Preview<");
  });

  it("ignores non-positive and non-integer line params", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "a.ts", line: "-4" };
    setupWorkspace();
    h.fileView = { ...h.emptyView, data: { contents: "x", truncated: false } };
    const markup = render(<ThreadFileScreen />);
    expect(markup).toContain('data-initial-line="null"');
  });

  it("exercises the breadcrumb fade visibility callbacks", () => {
    h.params = { environmentId: ENV, threadId: THREAD, path: "src/deep/a.ts" };
    setupWorkspace();
    h.fileView = { ...h.emptyView, data: { contents: "x", truncated: false } };

    render(<ThreadFileScreen />);
    const breadcrumbScroll = h.scrollViews.find((entry) => typeof entry.onScroll === "function");
    expect(breadcrumbScroll).toBeDefined();
    (breadcrumbScroll!.onContentSizeChange as (width: number) => void)(400);
    (breadcrumbScroll!.onLayout as (event: { nativeEvent: { layout: { width: number } } }) => void)(
      {
        nativeEvent: { layout: { width: 100 } },
      },
    );
    (
      breadcrumbScroll!.onScroll as (event: {
        nativeEvent: { contentOffset: { x: number } };
      }) => void
    )({
      nativeEvent: { contentOffset: { x: 50 } },
    });
  });
});
