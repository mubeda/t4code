import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  primitiveProps: [] as Array<{ name: string; props: Record<string, unknown> }>,
  filter: vi.fn(() => "filter"),
}));

vi.mock("@base-ui/react/combobox", async () => {
  const React = await import("react");
  const primitive = (name: string) => (props: Record<string, unknown>) => {
    harness.primitiveProps.push({ name, props });
    const children =
      typeof props.children === "function"
        ? (props.children as () => React.ReactNode)()
        : (props.children as React.ReactNode);
    return React.createElement(
      "div",
      { "data-primitive": name },
      props.render as React.ReactNode,
      children,
    );
  };
  return {
    Combobox: {
      Root: primitive("Root"),
      Input: primitive("Input"),
      Trigger: primitive("Trigger"),
      Icon: primitive("Icon"),
      Portal: primitive("Portal"),
      Positioner: primitive("Positioner"),
      Popup: primitive("Popup"),
      Item: primitive("Item"),
      ItemIndicator: primitive("ItemIndicator"),
      Separator: primitive("Separator"),
      Group: primitive("Group"),
      GroupLabel: primitive("GroupLabel"),
      Empty: primitive("Empty"),
      Row: primitive("Row"),
      Value: primitive("Value"),
      List: primitive("List"),
      Clear: primitive("Clear"),
      Status: primitive("Status"),
      Collection: primitive("Collection"),
      Chips: primitive("Chips"),
      Chip: primitive("Chip"),
      ChipRemove: primitive("ChipRemove"),
      useFilter: harness.filter,
    },
  };
});
vi.mock("~/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <div data-input={String(props.size)} />,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxClear,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxRow,
  ComboboxSeparator,
  ComboboxStatus,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxFilter,
} from "./combobox";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

function propsFor(name: string): Array<Record<string, unknown>> {
  return harness.primitiveProps.filter((entry) => entry.name === name).map((entry) => entry.props);
}

beforeEach(() => {
  harness.primitiveProps.length = 0;
  harness.filter.mockClear();
});

describe("combobox UI wrappers", () => {
  it("provides single and multiple combobox roots", () => {
    render(<Combobox items={["one"]}>Root child</Combobox>);
    render(
      <Combobox items={["one"]} multiple>
        Multiple child
      </Combobox>,
    );
    expect(propsFor("Root")).toHaveLength(2);
  });

  it("normalizes chip input sizes", () => {
    render(<ComboboxChipsInput />);
    render(<ComboboxChipsInput size="sm" className="small" />);
    render(<ComboboxChipsInput size={12} />);
    expect(propsFor("Input")[0]).toMatchObject({ "data-size": "default", size: undefined });
    expect(propsFor("Input")[1]).toMatchObject({ "data-size": "sm", size: undefined });
    expect(propsFor("Input")[2]).toMatchObject({ "data-size": undefined, size: 12 });
  });

  it("renders input addons, triggers, clears, and every size branch", () => {
    const full = render(
      <ComboboxInput
        size="sm"
        startAddon={<span>Start</span>}
        showTrigger
        showClear
        inputClassName="inner"
        className="outer"
      />,
    );
    expect(full).toContain("Start");
    expect(propsFor("Trigger")).toHaveLength(1);
    expect(propsFor("Clear")).toHaveLength(1);

    render(<ComboboxInput showTrigger={false} showClear={false} size={8} unstyled />);
    render(<ComboboxInput />);
    render(<ComboboxInput showClear />);
    expect(propsFor("Input")).toHaveLength(4);
  });

  it("positions popups with default, context, and explicit anchors", () => {
    render(<ComboboxPopup>Default popup</ComboboxPopup>);
    const anchor = { current: {} as Element };
    render(
      <ComboboxPopup anchor={anchor} side="top" align="end" sideOffset={9} alignOffset={2}>
        Custom popup
      </ComboboxPopup>,
    );
    expect(propsFor("Positioner")[0]).toMatchObject({
      align: "start",
      side: "bottom",
      sideOffset: 4,
      anchor: null,
    });
    expect(propsFor("Positioner")[1]).toMatchObject({
      align: "end",
      side: "top",
      sideOffset: 9,
      alignOffset: 2,
      anchor,
    });
  });

  it("renders item indicator and indicator-free layouts", () => {
    render(<ComboboxItem>Selected</ComboboxItem>);
    render(
      <ComboboxItem hideIndicator contentClassName="content">
        Hidden
      </ComboboxItem>,
    );
    expect(propsFor("ItemIndicator")[0]?.className).not.toContain("hidden");
    expect(propsFor("ItemIndicator")[1]?.className).toContain("hidden");
  });

  it("renders all structural wrappers and chips", () => {
    const markup = render(
      <Combobox multiple items={["one"]}>
        <ComboboxChips startAddon={<span>Addon</span>}>
          <ComboboxChip>One</ComboboxChip>
          <ComboboxChipsInput size="lg" />
        </ComboboxChips>
        <ComboboxTrigger>Open</ComboboxTrigger>
        <ComboboxSeparator />
        <ComboboxGroup>
          <ComboboxGroupLabel>Group</ComboboxGroupLabel>
          <ComboboxRow>Row</ComboboxRow>
          <ComboboxValue>Value</ComboboxValue>
          <ComboboxEmpty>Empty</ComboboxEmpty>
          <ComboboxStatus>Status</ComboboxStatus>
          <ComboboxCollection>{() => <span>Collection</span>}</ComboboxCollection>
        </ComboboxGroup>
        <ComboboxList>List</ComboboxList>
        <ComboboxListVirtualized>Virtual</ComboboxListVirtualized>
        <ComboboxClear>Clear</ComboboxClear>
      </Combobox>,
    );
    expect(markup).toContain("Addon");
    expect(propsFor("Chips")[0]?.ref).toBeTruthy();
    expect(propsFor("ChipRemove")[0]).toMatchObject({ "aria-label": "Remove" });
    expect(propsFor("List")).toHaveLength(2);
    expect(useComboboxFilter()).toBe("filter");
    expect(harness.filter).toHaveBeenCalledOnce();

    render(<ComboboxChips>Without addon</ComboboxChips>);
  });
});
