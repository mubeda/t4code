import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  collapsed: false,
  setCollapsed: vi.fn(),
  listProps: [] as Array<Record<string, unknown>>,
  buttons: [] as Array<Record<string, unknown>>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: () => [harness.collapsed, harness.setCollapsed],
}));
vi.mock("./SourceControlChangesList", () => ({
  SourceControlChangesList: (props: Record<string, unknown>) => {
    harness.listProps.push(props);
    return <div data-changes-list />;
  },
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));

import { SourceControlSection } from "./SourceControlSection";

const file = {
  path: "src/file.ts",
  insertions: 3,
  deletions: 1,
  status: "added" as const,
  area: "unstaged" as const,
};

function visit(node: React.ReactNode, entries: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, entries);
    return entries;
  }
  if (!React.isValidElement(node)) return entries;
  entries.push(node);
  visit((node.props as { children?: React.ReactNode }).children, entries);
  return entries;
}

function renderSection(overrides: Partial<React.ComponentProps<typeof SourceControlSection>> = {}) {
  const tree = SourceControlSection({
    title: "Changes",
    files: [file],
    onToggle: vi.fn(),
    onOpenFile: vi.fn(),
    ...overrides,
  });
  return { tree, markup: tree ? renderToStaticMarkup(tree) : "" };
}

function invokeClick(props: Record<string, unknown> | undefined): void {
  if (typeof props?.onClick !== "function") throw new Error("Missing click handler");
  props.onClick();
}

beforeEach(() => {
  harness.collapsed = false;
  harness.setCollapsed.mockReset();
  harness.listProps.length = 0;
  harness.buttons.length = 0;
});

describe("SourceControlSection", () => {
  it("does not render an empty section", () => {
    expect(renderSection({ files: [] }).tree).toBeNull();
  });

  it("renders the default expanded section and toggles its header", () => {
    const { tree, markup } = renderSection();
    expect(markup).toContain("Changes");
    expect(markup).toContain("data-changes-list");
    expect(harness.listProps[0]).not.toHaveProperty("checked");
    expect(harness.listProps[0]).not.toHaveProperty("disabled");

    const header = visit(tree).find(
      (element) =>
        element.type === "button" &&
        String((element.props as Record<string, unknown>).className).includes("flex-1"),
    );
    if (!header) throw new Error("Missing section header");
    (header.props as { onClick: () => void }).onClick();
    const update = harness.setCollapsed.mock.calls[0]?.[0] as
      | ((value: boolean) => boolean)
      | undefined;
    expect(update?.(false)).toBe(true);
    expect(update?.(true)).toBe(false);

    const renderBadge = harness.listProps[0]?.renderBadge;
    if (typeof renderBadge !== "function") throw new Error("Missing badge renderer");
    expect(renderToStaticMarkup(renderBadge(file))).toContain("Added");
    expect(renderToStaticMarkup(renderBadge({ ...file, status: undefined }))).toContain("Modified");
  });

  it("forwards every row action and renders stage and discard controls", () => {
    const primary = vi.fn();
    const discard = vi.fn();
    const checked = vi.fn();
    const selected = vi.fn();
    const onSelect = vi.fn();
    const actions = {
      onStageFile: vi.fn(),
      onUnstageFile: vi.fn(),
      onRequestDiscardFile: vi.fn(),
      onOpenExternalEditor: vi.fn(),
      onCopyPath: vi.fn(),
      onViewFile: vi.fn(),
      onIgnoreFileName: vi.fn(),
      onIgnoreParentFolder: vi.fn(),
    };
    renderSection({
      checked,
      selected,
      onSelect,
      disabled: false,
      isPrimaryEnv: true,
      primaryAction: { icon: "stage", label: "Stage all", onClick: primary },
      onDiscard: discard,
      ...actions,
    });
    expect(harness.listProps[0]).toMatchObject({
      checked,
      selected,
      onSelect,
      disabled: false,
      isPrimaryEnv: true,
      ...actions,
    });
    expect(harness.buttons[0]).toMatchObject({ "aria-label": "Stage all", disabled: false });
    expect(harness.buttons[1]).toMatchObject({
      "aria-label": "Discard all",
      title: "Discard all",
      disabled: false,
    });
    invokeClick(harness.buttons[0]);
    invokeClick(harness.buttons[1]);
    expect(primary).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("renders the unstage and destructive delete variants while collapsed", () => {
    harness.collapsed = true;
    const { markup } = renderSection({
      primaryAction: { icon: "unstage", label: "Unstage all", onClick: vi.fn() },
      onDiscard: vi.fn(),
      discardVariant: "delete-untracked",
      disabled: true,
    });
    expect(markup).toContain("-rotate-90");
    expect(markup).not.toContain("data-changes-list");
    expect(harness.buttons[0]).toMatchObject({ "aria-label": "Unstage all", disabled: true });
    expect(harness.buttons[1]).toMatchObject({
      "aria-label": "Delete all untracked",
      title: "Delete all untracked",
      disabled: true,
    });
    expect(String(harness.buttons[1]?.className)).toContain("text-destructive");
  });
});
