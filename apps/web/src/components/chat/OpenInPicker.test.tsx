import { EditorId, EnvironmentId, type ResolvedKeybindingsConfig } from "@t4code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  preferredEditor: null as EditorId | null,
  setPreferredEditor: vi.fn(),
  openInEditor: vi.fn(),
  buttons: [] as Array<Record<string, unknown>>,
  menuItems: [] as Array<Record<string, unknown>>,
  effects: [] as Array<() => void | (() => void)>,
  shortcutMatches: false,
  shortcutLabel: "Ctrl+Shift+O" as string | null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  },
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("../../editorPreferences", () => ({
  usePreferredEditor: () => [harness.preferredEditor, harness.setPreferredEditor],
}));
vi.mock("../../keybindings", () => ({
  isOpenFavoriteEditorShortcut: () => harness.shortcutMatches,
  shortcutLabelForCommand: () => harness.shortcutLabel,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => harness.openInEditor,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("../ui/group", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  GroupSeparator: (props: Record<string, unknown>) => <hr className={props.className as string} />,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children, render }: { children: React.ReactNode; render: React.ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: (props: Record<string, unknown>) => {
    harness.menuItems.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
  MenuShortcut: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
}));

import { OpenInPicker } from "./OpenInPicker";

const environmentId = EnvironmentId.make("environment-1");
const keybindings = [] as ResolvedKeybindingsConfig;
const allEditors = [
  "cursor",
  "trae",
  "kiro",
  "vscode",
  "vscode-insiders",
  "vscodium",
  "zed",
  "antigravity",
  "idea",
  "aqua",
  "clion",
  "datagrip",
  "dataspell",
  "goland",
  "phpstorm",
  "pycharm",
  "rider",
  "rubymine",
  "rustrover",
  "webstorm",
  "file-manager",
] as ReadonlyArray<EditorId>;

function renderPicker(overrides: Partial<React.ComponentProps<typeof OpenInPicker>> = {}): string {
  return renderToStaticMarkup(
    <OpenInPicker
      environmentId={environmentId}
      keybindings={keybindings}
      availableEditors={allEditors}
      openInCwd="/repo"
      {...overrides}
    />,
  );
}

function invokeClick(props: Record<string, unknown> | undefined): unknown {
  if (typeof props?.onClick !== "function") throw new Error("Missing click handler");
  return props.onClick();
}

beforeEach(() => {
  harness.preferredEditor = "vscode";
  harness.setPreferredEditor.mockReset();
  harness.openInEditor.mockReset();
  harness.openInEditor.mockReturnValue("opened");
  harness.buttons.length = 0;
  harness.menuItems.length = 0;
  harness.effects.length = 0;
  harness.shortcutMatches = false;
  harness.shortcutLabel = "Ctrl+Shift+O";
  harness.addEventListener.mockReset();
  harness.removeEventListener.mockReset();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", {
    addEventListener: harness.addEventListener,
    removeEventListener: harness.removeEventListener,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenInPicker", () => {
  it("renders every available editor and the platform-specific file manager", () => {
    const markup = renderPicker();
    expect(markup).toContain("Cursor");
    expect(markup).toContain("VS Code Insiders");
    expect(markup).toContain("WebStorm");
    expect(markup).toContain("Finder");
    expect(markup).toContain("Ctrl+Shift+O");
    expect(harness.menuItems).toHaveLength(allEditors.length);
    expect(harness.buttons[0]).toMatchObject({ disabled: false, "aria-label": undefined });

    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(renderPicker()).toContain("Explorer");
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    expect(renderPicker()).toContain("Files");
  });

  it("renders the empty and compact states", () => {
    harness.preferredEditor = null;
    harness.shortcutLabel = null;
    const markup = renderPicker({ availableEditors: [], openInCwd: null, compact: true });
    expect(markup).toContain("No installed editors found");
    expect(harness.buttons[0]).toMatchObject({
      disabled: true,
      "aria-label": "Open file in preferred editor",
    });
    expect(harness.buttons[1]).toMatchObject({ "aria-label": "Choose editor" });
  });

  it("opens the preferred or selected editor and preserves guarded actions", () => {
    renderPicker();
    const cursor = harness.menuItems.find((item) =>
      (item.children as React.ReactNode[]).includes("Cursor"),
    );
    expect(invokeClick(harness.buttons[0])).toBe("opened");
    invokeClick(cursor);
    expect(harness.openInEditor).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: { cwd: "/repo", editor: "vscode" },
    });
    expect(harness.openInEditor).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: { cwd: "/repo", editor: "cursor" },
    });
    expect(harness.setPreferredEditor).toHaveBeenNthCalledWith(1, "vscode");
    expect(harness.setPreferredEditor).toHaveBeenNthCalledWith(2, "cursor");

    harness.buttons.length = 0;
    harness.menuItems.length = 0;
    harness.preferredEditor = null;
    renderPicker({ availableEditors: ["cursor"], openInCwd: null });
    invokeClick(harness.buttons[0]);
    invokeClick(harness.menuItems[0]);
    expect(harness.openInEditor).toHaveBeenCalledTimes(2);

    harness.buttons.length = 0;
    harness.menuItems.length = 0;
    renderPicker({ availableEditors: ["cursor"], openInCwd: "/repo" });
    invokeClick(harness.buttons[0]);
    expect(harness.openInEditor).toHaveBeenCalledTimes(2);
  });

  it("handles favorite-editor shortcuts and removes the listener", () => {
    renderPicker();
    const cleanup = harness.effects[0]?.();
    expect(harness.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    const handler = harness.addEventListener.mock.calls[0]?.[1] as (event: KeyboardEvent) => void;
    const event = { preventDefault: vi.fn() } as unknown as KeyboardEvent;

    handler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    harness.shortcutMatches = true;
    handler(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.openInEditor).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", editor: "vscode" },
    });
    if (typeof cleanup === "function") cleanup();
    expect(harness.removeEventListener).toHaveBeenCalledWith("keydown", handler);
  });

  it("does not install or execute shortcuts without required state", () => {
    renderPicker({ enableShortcut: false });
    expect(harness.effects[0]?.()).toBeUndefined();
    expect(harness.addEventListener).not.toHaveBeenCalled();

    harness.effects.length = 0;
    harness.preferredEditor = null;
    renderPicker({ openInCwd: "/repo" });
    harness.effects[0]?.();
    const withoutEditor = harness.addEventListener.mock.calls[0]?.[1] as (
      event: KeyboardEvent,
    ) => void;
    harness.shortcutMatches = true;
    withoutEditor({ preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(harness.openInEditor).not.toHaveBeenCalled();

    harness.effects.length = 0;
    harness.addEventListener.mockReset();
    harness.preferredEditor = "vscode";
    renderPicker({ openInCwd: null });
    harness.effects[0]?.();
    const withoutCwd = harness.addEventListener.mock.calls[0]?.[1] as (
      event: KeyboardEvent,
    ) => void;
    withoutCwd({ preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(harness.openInEditor).not.toHaveBeenCalled();
  });
});
