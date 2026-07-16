import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  shortcutLabel: vi.fn(() => "⌘K"),
}));

vi.mock("../keybindings", () => ({ shortcutLabelForCommand: harness.shortcutLabel }));
vi.mock("./ui/command", () => ({
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CommandGroupLabel: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CommandCollection: ({ children }: { children: (item: never) => React.ReactNode }) => (
    <>{harness.items.map((item) => children(item as never))}</>
  ),
  CommandItem: (props: Record<string, unknown>) => (
    <button type="button">{props.children as React.ReactNode}</button>
  ),
  CommandShortcut: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
}));

import { CommandPaletteResults } from "./CommandPaletteResults";

const keybindings = {} as never;

beforeEach(() => {
  harness.items.length = 0;
  harness.shortcutLabel.mockClear();
});

describe("CommandPaletteResults", () => {
  it("renders each empty-state message", () => {
    expect(
      renderToStaticMarkup(
        <CommandPaletteResults
          groups={[]}
          isActionsOnly
          keybindings={keybindings}
          onExecuteItem={vi.fn()}
        />,
      ),
    ).toContain("No matching actions.");
    expect(
      renderToStaticMarkup(
        <CommandPaletteResults
          groups={[]}
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={vi.fn()}
        />,
      ),
    ).toContain("No matching commands, projects, or threads.");
    expect(
      renderToStaticMarkup(
        <CommandPaletteResults
          groups={[]}
          emptyStateMessage="Nothing here"
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={vi.fn()}
        />,
      ),
    ).toContain("Nothing here");
  });

  it("renders disabled and enabled action and submenu rows", () => {
    const onExecuteItem = vi.fn();
    harness.items.push(
      {
        kind: "action",
        value: "disabled-description",
        title: "Disabled described",
        description: "Unavailable",
        disabled: true,
        icon: <span>icon</span>,
        titleLeadingContent: <span>lead</span>,
        titleTrailingContent: <span>trail</span>,
      },
      {
        kind: "action",
        value: "disabled-simple",
        title: "Disabled simple",
        disabled: true,
      },
      {
        kind: "action",
        value: "enabled-description",
        title: "Enabled described",
        description: "Open it",
        disabled: false,
        shortcutCommand: "commandPalette.toggle",
        timestamp: "2m",
      },
      {
        kind: "submenu",
        value: "submenu",
        title: "Submenu",
        disabled: false,
      },
    );
    const markup = renderToStaticMarkup(
      <CommandPaletteResults
        groups={[{ value: "group", label: "Commands", items: harness.items } as never]}
        highlightedItemValue="enabled-description"
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={onExecuteItem}
      />,
    );
    expect(markup).toContain("Disabled described");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Disabled simple");
    expect(markup).toContain("Enabled described");
    expect(markup).toContain("⌘K");
    expect(markup).toContain("2m");
    expect(markup).toContain("Submenu");
    expect(harness.shortcutLabel).toHaveBeenCalled();
  });
});
