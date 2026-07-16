// @vitest-environment happy-dom

import { ProviderDriverKind } from "@t4code/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("lucide-react", () => ({
  BotIcon: () => <span data-icon="bot" />,
}));

vi.mock("~/providerSkillPresentation", () => ({
  formatProviderSkillInstallSource: (skill: { id?: string }) => `source:${skill.id ?? "unknown"}`,
}));

vi.mock("~/lib/utils", () => ({
  cn: (...values: ReadonlyArray<unknown>) => values.filter(Boolean).join(" "),
}));

vi.mock("./PierreEntryIcon", () => ({
  PierreEntryIcon: (props: { pathValue: string; kind: string; theme: string }) => (
    <span
      data-icon="path"
      data-path={props.pathValue}
      data-kind={props.kind}
      data-theme={props.theme}
    />
  ),
}));

vi.mock("../ui/command", () => ({
  Command: ({
    children,
    onItemHighlighted,
  }: {
    children?: ReactNode;
    onItemHighlighted?: (value: unknown) => void;
  }) => (
    <div data-command>
      <button
        type="button"
        data-highlight-string
        onClick={() => onItemHighlighted?.("item-from-command")}
      />
      <button type="button" data-highlight-null onClick={() => onItemHighlighted?.({})} />
      {children}
    </div>
  ),
  CommandList: ({ children, ...props }: React.ComponentPropsWithoutRef<"div">) => (
    <div data-command-list {...props}>
      {children}
    </div>
  ),
  CommandGroup: ({ children }: { children?: ReactNode }) => (
    <section data-command-group>{children}</section>
  ),
  CommandGroupLabel: ({ children }: { children?: ReactNode }) => (
    <h3 data-command-group-label>{children}</h3>
  ),
  CommandSeparator: () => <hr data-command-separator />,
  CommandItem: ({
    children,
    value: _value,
    ...props
  }: React.ComponentPropsWithoutRef<"button"> & { value?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
const onHighlightedItemChange = vi.fn();
const onSelect = vi.fn();

function pathItem(id = "path-1"): ComposerCommandItem {
  return {
    id,
    type: "path",
    path: "src/main.ts",
    pathKind: "file",
    label: "src/main.ts",
    description: "Project file",
  };
}

function slashItem(id = "slash-1"): ComposerCommandItem {
  return {
    id,
    type: "slash-command",
    command: { name: "review" } as never,
    label: "/review",
    description: "Review changes",
  };
}

function providerCommandItem(id = "provider-1"): ComposerCommandItem {
  return {
    id,
    type: "provider-slash-command",
    provider: ProviderDriverKind.make("codex"),
    command: { name: "compact" } as never,
    label: "/compact",
    description: "Compact context",
  };
}

function agentItem(id = "agent-1"): ComposerCommandItem {
  return {
    id,
    type: "provider-agent",
    provider: ProviderDriverKind.make("claude"),
    agent: { name: "planner" } as never,
    label: "planner",
    description: "Planning agent",
  };
}

function skillItem(id = "skill-1"): ComposerCommandItem {
  return {
    id,
    type: "skill",
    provider: ProviderDriverKind.make("codex"),
    skill: { id: "coverage-skill", name: "Coverage" } as never,
    label: "Coverage",
    description: "Improve tests",
  };
}

function renderMenu(
  overrides: Partial<React.ComponentProps<typeof ComposerCommandMenu>> = {},
): ReactElement {
  return (
    <ComposerCommandMenu
      items={[]}
      resolvedTheme="light"
      isLoading={false}
      triggerKind={null}
      activeItemId={null}
      onHighlightedItemChange={onHighlightedItemChange}
      onSelect={onSelect}
      {...overrides}
    />
  );
}

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  await act(async () => root.render(element));
  return mounted;
}

async function dispatch(element: HTMLElement, event: Event): Promise<void> {
  await act(async () => element.dispatchEvent(event));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onHighlightedItemChange.mockReset();
  onSelect.mockReset();
  vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll(":", "\\:") });
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ComposerCommandMenu empty states", () => {
  it.each([
    ["skill", true, "Searching workspace skills..."],
    ["skill", false, "No skills found. Try / to browse provider commands."],
    ["path", true, "Searching workspace files..."],
    ["path", false, "No matching files or folders."],
    ["slash-command", false, "No matching command."],
  ] as const)("renders the %s empty state", async (triggerKind, isLoading, expected) => {
    const mounted = await mount(renderMenu({ triggerKind, isLoading }));

    expect(mounted.container.textContent).toContain(expected);
  });

  it("prefers custom empty-state text", async () => {
    const mounted = await mount(
      renderMenu({ triggerKind: "path", emptyStateText: "Nothing in this workspace." }),
    );

    expect(mounted.container.textContent).toContain("Nothing in this workspace.");
  });
});

describe("ComposerCommandMenu grouping", () => {
  it("groups slash commands into built-in, provider, and agent sections", async () => {
    const mounted = await mount(
      renderMenu({
        triggerKind: "slash-command",
        items: [agentItem(), slashItem(), providerCommandItem()],
      }),
    );

    expect(
      Array.from(mounted.container.querySelectorAll("[data-command-group-label]"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Built-in", "Provider", "Agents"]);
    expect(mounted.container.querySelectorAll("[data-command-separator]")).toHaveLength(2);
  });

  it("uses one unlabeled group when slash grouping is disabled", async () => {
    const mounted = await mount(
      renderMenu({
        triggerKind: "slash-command",
        groupSlashCommandSections: false,
        items: [slashItem(), providerCommandItem()],
      }),
    );

    expect(mounted.container.querySelectorAll("[data-command-group]")).toHaveLength(1);
    expect(mounted.container.querySelectorAll("[data-command-group-label]")).toHaveLength(0);
  });

  it("places skill results in a labeled skills group", async () => {
    const mounted = await mount(renderMenu({ triggerKind: "skill", items: [skillItem()] }));

    expect(mounted.container.querySelector("[data-command-group-label]")?.textContent).toBe(
      "Skills",
    );
    expect(mounted.container.textContent).toContain("source:coverage-skill");
  });
});

describe("ComposerCommandMenu item behavior", () => {
  it("renders each item type with its semantic glyph", async () => {
    const mounted = await mount(
      renderMenu({
        items: [pathItem(), slashItem(), providerCommandItem(), agentItem(), skillItem()],
      }),
    );

    expect(mounted.container.querySelector("[data-icon=path]")).toMatchObject({
      dataset: { path: "src/main.ts", kind: "file", theme: "light" },
    });
    expect(mounted.container.querySelectorAll("[data-icon=bot]")).toHaveLength(2);
    expect(mounted.container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("highlights inactive items, preserves active items, and selects by click", async () => {
    const inactive = pathItem("inactive");
    const active = slashItem("active");
    const mounted = await mount(renderMenu({ items: [inactive, active], activeItemId: "active" }));
    const inactiveButton = mounted.container.querySelector<HTMLElement>(
      '[data-composer-item-id="inactive"]',
    )!;
    const activeButton = mounted.container.querySelector<HTMLElement>(
      '[data-composer-item-id="active"]',
    )!;

    await dispatch(inactiveButton, new MouseEvent("mousemove", { bubbles: true }));
    await dispatch(activeButton, new MouseEvent("mousemove", { bubbles: true }));
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await dispatch(inactiveButton, mouseDown);
    await dispatch(inactiveButton, new MouseEvent("click", { bubbles: true }));

    expect(onHighlightedItemChange).toHaveBeenCalledOnce();
    expect(onHighlightedItemChange).toHaveBeenCalledWith("inactive");
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(inactive);
  });

  it("normalizes command-level highlight values", async () => {
    const mounted = await mount(renderMenu());

    await dispatch(
      mounted.container.querySelector<HTMLElement>("[data-highlight-string]")!,
      new MouseEvent("click", { bubbles: true }),
    );
    await dispatch(
      mounted.container.querySelector<HTMLElement>("[data-highlight-null]")!,
      new MouseEvent("click", { bubbles: true }),
    );

    expect(onHighlightedItemChange.mock.calls).toEqual([["item-from-command"], [null]]);
  });

  it("scrolls the active item into view when present", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);

    await mount(renderMenu({ items: [pathItem("path:active")], activeItemId: "path:active" }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});
