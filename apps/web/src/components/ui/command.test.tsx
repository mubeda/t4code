import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  props: [] as Array<{ name: string; props: Record<string, unknown> }>,
  createHandle: vi.fn(() => ({ handle: true })),
}));

vi.mock("@base-ui/react/dialog", async () => {
  const React = await import("react");
  const primitive = (name: string) => (props: Record<string, unknown>) => {
    harness.props.push({ name, props });
    return React.createElement(
      "div",
      { "data-primitive": name },
      props.children as React.ReactNode,
    );
  };
  return {
    Dialog: {
      Root: primitive("DialogRoot"),
      Portal: primitive("DialogPortal"),
      Trigger: primitive("DialogTrigger"),
      Backdrop: primitive("DialogBackdrop"),
      Viewport: primitive("DialogViewport"),
      Popup: primitive("DialogPopup"),
      createHandle: harness.createHandle,
    },
  };
});
vi.mock("~/components/ui/autocomplete", async () => {
  const React = await import("react");
  const primitive = (name: string) => (props: Record<string, unknown>) => {
    harness.props.push({ name, props });
    const children =
      typeof props.children === "function"
        ? (props.children as () => React.ReactNode)()
        : (props.children as React.ReactNode);
    return React.createElement("div", { "data-primitive": name }, children);
  };
  return {
    Autocomplete: primitive("Autocomplete"),
    AutocompleteCollection: primitive("Collection"),
    AutocompleteEmpty: primitive("Empty"),
    AutocompleteGroup: primitive("Group"),
    AutocompleteGroupLabel: primitive("GroupLabel"),
    AutocompleteInput: primitive("Input"),
    AutocompleteItem: primitive("Item"),
    AutocompleteList: primitive("List"),
    AutocompleteSeparator: primitive("Separator"),
  };
});

import {
  Command,
  CommandCollection,
  CommandCreateHandle,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from "./command";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

function propsFor(name: string): Array<Record<string, unknown>> {
  return harness.props.filter((entry) => entry.name === name).map((entry) => entry.props);
}

beforeEach(() => {
  harness.props.length = 0;
  harness.createHandle.mockClear();
});

describe("command UI wrappers", () => {
  it("applies command defaults and explicit highlight settings", () => {
    render(<Command items={["one"]}>Default</Command>);
    render(
      <Command items={["one"]} autoHighlight={false} keepHighlight={false}>
        Explicit
      </Command>,
    );
    expect(propsFor("Autocomplete")[0]).toMatchObject({
      autoHighlight: "always",
      keepHighlight: true,
      inline: true,
      open: true,
    });
    expect(propsFor("Autocomplete")[1]).toMatchObject({
      autoHighlight: false,
      keepHighlight: false,
    });
  });

  it("renders dialog primitives and forwards backdrop handling", () => {
    const onBackdropPointerDown = vi.fn();
    render(
      <CommandDialog open>
        <CommandDialogTrigger>Open</CommandDialogTrigger>
        <CommandDialogPopup onBackdropPointerDown={onBackdropPointerDown} className="popup">
          Dialog
        </CommandDialogPopup>
      </CommandDialog>,
    );
    expect(propsFor("DialogBackdrop")[0]?.onPointerDown).toBe(onBackdropPointerDown);
    expect(propsFor("DialogPopup")[0]?.className).toContain("popup");
    expect(CommandCreateHandle()).toEqual({ handle: true });
  });

  it("renders every command content wrapper", () => {
    const markup = render(
      <>
        <CommandInput placeholder="Search" wrapperClassName="wrapper" className="input" />
        <CommandPanel className="panel">Panel</CommandPanel>
        <CommandList className="list">List</CommandList>
        <CommandEmpty className="empty">Empty</CommandEmpty>
        <CommandGroup className="group">Group</CommandGroup>
        <CommandGroupLabel className="label">Label</CommandGroupLabel>
        <CommandCollection>{() => <span>Collection</span>}</CommandCollection>
        <CommandItem className="item">Item</CommandItem>
        <CommandSeparator className="separator" />
        <CommandShortcut className="shortcut">⌘K</CommandShortcut>
        <CommandFooter className="footer">Footer</CommandFooter>
      </>,
    );
    expect(markup).toContain("Panel");
    expect(markup).toContain("⌘K");
    expect(propsFor("Input")[0]).toMatchObject({ autoFocus: true, size: "lg" });
    expect(propsFor("Item")[0]?.className).toContain("py-1.5");
  });
});
