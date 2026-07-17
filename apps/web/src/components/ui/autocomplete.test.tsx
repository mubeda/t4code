import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  primitiveProps: [] as Array<{ name: string; props: Record<string, unknown> }>,
  filter: vi.fn(() => "filter"),
}));

vi.mock("@base-ui/react/autocomplete", async () => {
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
    Autocomplete: {
      Root: primitive("Root"),
      Input: primitive("Input"),
      Trigger: primitive("Trigger"),
      Icon: primitive("Icon"),
      Portal: primitive("Portal"),
      Positioner: primitive("Positioner"),
      Popup: primitive("Popup"),
      Item: primitive("Item"),
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
  Autocomplete,
  AutocompleteClear,
  AutocompleteCollection,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
  AutocompleteRow,
  AutocompleteSeparator,
  AutocompleteStatus,
  AutocompleteTrigger,
  AutocompleteValue,
  useAutocompleteFilter,
} from "./autocomplete";

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

describe("autocomplete UI wrappers", () => {
  it("renders input addon and control combinations", () => {
    expect(
      render(
        <AutocompleteInput
          startAddon={<span>Search</span>}
          showTrigger
          showClear
          size="sm"
          className="outer"
        />,
      ),
    ).toContain("Search");
    render(<AutocompleteInput size={10} />);
    render(<AutocompleteInput showTrigger showClear />);
    expect(propsFor("Input")).toHaveLength(3);
    expect(propsFor("Trigger")).toHaveLength(2);
    expect(propsFor("Clear")).toHaveLength(2);
  });

  it("positions default and custom popups", () => {
    render(<AutocompletePopup>Default</AutocompletePopup>);
    const anchor = { current: {} as Element };
    render(
      <AutocompletePopup anchor={anchor} side="top" align="end" sideOffset={8} alignOffset={3}>
        Custom
      </AutocompletePopup>,
    );
    expect(propsFor("Positioner")[0]).toMatchObject({
      align: "start",
      side: "bottom",
      sideOffset: 4,
    });
    expect(propsFor("Positioner")[1]).toMatchObject({
      anchor,
      align: "end",
      side: "top",
      sideOffset: 8,
      alignOffset: 3,
    });
  });

  it("renders every structural wrapper", () => {
    const markup = render(
      <Autocomplete items={["one"]}>
        <AutocompleteTrigger>Open</AutocompleteTrigger>
        <AutocompleteItem>Item</AutocompleteItem>
        <AutocompleteSeparator />
        <AutocompleteGroup>
          <AutocompleteGroupLabel>Label</AutocompleteGroupLabel>
          <AutocompleteRow>Row</AutocompleteRow>
          <AutocompleteValue>Value</AutocompleteValue>
          <AutocompleteEmpty>Empty</AutocompleteEmpty>
          <AutocompleteStatus>Status</AutocompleteStatus>
          <AutocompleteCollection>{() => <span>Collection</span>}</AutocompleteCollection>
        </AutocompleteGroup>
        <AutocompleteList>List</AutocompleteList>
        <AutocompleteClear>Clear</AutocompleteClear>
      </Autocomplete>,
    );
    expect(markup).toContain("Collection");
    expect(propsFor("Root")).toHaveLength(1);
    expect(propsFor("List")).toHaveLength(1);
    expect(useAutocompleteFilter()).toBe("filter");
    expect(harness.filter).toHaveBeenCalledOnce();
  });
});
