import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  primitiveProps: [] as Array<{ name: string; props: Record<string, unknown> }>,
  scrollProps: [] as Array<Record<string, unknown>>,
}));

function primitiveModule(names: readonly string[]) {
  return import("react").then((React) => {
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
    return Object.fromEntries(names.map((name) => [name, primitive(name)]));
  });
}

vi.mock("@base-ui/react/alert-dialog", async () => ({
  AlertDialog: {
    ...(await primitiveModule([
      "Root",
      "Portal",
      "Trigger",
      "Close",
      "Backdrop",
      "Viewport",
      "Popup",
      "Title",
      "Description",
    ])),
    createHandle: vi.fn(),
  },
}));

vi.mock("@base-ui/react/dialog", async () => ({
  Dialog: {
    ...(await primitiveModule([
      "Root",
      "Portal",
      "Trigger",
      "Close",
      "Backdrop",
      "Viewport",
      "Popup",
      "Title",
      "Description",
    ])),
    createHandle: vi.fn(),
  },
}));

vi.mock("@base-ui/react/menu", async () => ({
  Menu: {
    ...(await primitiveModule([
      "Root",
      "Portal",
      "Trigger",
      "Positioner",
      "Popup",
      "Group",
      "Item",
      "CheckboxItem",
      "CheckboxItemIndicator",
      "RadioGroup",
      "RadioItem",
      "RadioItemIndicator",
      "GroupLabel",
      "Separator",
      "SubmenuRoot",
      "SubmenuTrigger",
    ])),
    createHandle: vi.fn(),
  },
}));

vi.mock("@base-ui/react/popover", async () => ({
  Popover: {
    ...(await primitiveModule([
      "Root",
      "Portal",
      "Trigger",
      "Positioner",
      "Popup",
      "Viewport",
      "Close",
      "Title",
      "Description",
    ])),
    createHandle: vi.fn(),
  },
}));

vi.mock("@base-ui/react/select", async () => ({
  Select: {
    ...(await primitiveModule([
      "Root",
      "Trigger",
      "Icon",
      "Value",
      "Portal",
      "Positioner",
      "Popup",
      "ScrollUpArrow",
      "List",
      "ScrollDownArrow",
      "Item",
      "ItemIndicator",
      "ItemText",
      "Separator",
      "Group",
      "GroupLabel",
    ])),
  },
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: (props: Record<string, unknown>) => {
    harness.scrollProps.push(props);
    return <section>{props.children as React.ReactNode}</section>;
  },
}));

import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertDialogViewport,
} from "./alert-dialog";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
  DialogViewport,
} from "./dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./menu";
import {
  Popover,
  PopoverClose,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";
import {
  Select,
  SelectButton,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

function propsFor(name: string): Array<Record<string, unknown>> {
  return harness.primitiveProps.filter((entry) => entry.name === name).map((entry) => entry.props);
}

beforeEach(() => {
  harness.primitiveProps.length = 0;
  harness.scrollProps.length = 0;
});

describe("overlay UI wrappers", () => {
  it("renders alert-dialog structure and both footer and mobile layouts", () => {
    render(
      <AlertDialog open>
        <AlertDialogTrigger>Open</AlertDialogTrigger>
        <AlertDialogClose>Close</AlertDialogClose>
        <AlertDialogBackdrop className="backdrop" />
        <AlertDialogViewport className="viewport" />
        <AlertDialogTitle>Title</AlertDialogTitle>
        <AlertDialogDescription>Description</AlertDialogDescription>
      </AlertDialog>,
    );
    render(<AlertDialogPopup className="popup">Default popup</AlertDialogPopup>);
    render(<AlertDialogPopup bottomStickOnMobile={false}>Desktop popup</AlertDialogPopup>);
    const structural = render(
      <>
        <AlertDialogHeader>Header</AlertDialogHeader>
        <AlertDialogFooter>Default footer</AlertDialogFooter>
        <AlertDialogFooter variant="bare">Bare footer</AlertDialogFooter>
      </>,
    );

    expect(propsFor("Root")).toHaveLength(1);
    expect(propsFor("Backdrop")[0]?.className).toContain("backdrop");
    expect(propsFor("Popup")).toHaveLength(2);
    expect(structural).toContain("Default footer");
    expect(structural).toContain("Bare footer");
  });

  it("renders dialog close, panel, footer, and mobile branches", () => {
    render(
      <Dialog open>
        <DialogTrigger>Open</DialogTrigger>
        <DialogClose>Close</DialogClose>
        <DialogBackdrop className="backdrop" />
        <DialogViewport className="viewport" />
        <DialogTitle>Title</DialogTitle>
        <DialogDescription>Description</DialogDescription>
      </Dialog>,
    );
    render(<DialogPopup>Default popup</DialogPopup>);
    render(
      <DialogPopup bottomStickOnMobile={false} showCloseButton={false}>
        Plain popup
      </DialogPopup>,
    );
    const structural = render(
      <>
        <DialogHeader>Header</DialogHeader>
        <DialogFooter>Default footer</DialogFooter>
        <DialogFooter variant="bare">Bare footer</DialogFooter>
        <DialogPanel>Faded panel</DialogPanel>
        <DialogPanel scrollFade={false}>Static panel</DialogPanel>
      </>,
    );

    expect(propsFor("Close")).toHaveLength(2);
    expect(propsFor("Popup")).toHaveLength(2);
    expect(harness.scrollProps.map((props) => props.scrollFade)).toEqual([true, false]);
    expect(structural).toContain("Static panel");
  });
});

describe("menu, popover, and select wrappers", () => {
  it("renders menu item variants, checkbox layouts, and submenu offsets", () => {
    const markup = render(
      <Menu open>
        <MenuTrigger className="trigger">Open</MenuTrigger>
        <MenuPopup>Default popup</MenuPopup>
        <MenuPopup align="end" alignOffset={3} side="top" sideOffset={8}>
          Custom popup
        </MenuPopup>
        <MenuGroup>
          <MenuGroupLabel inset>Group</MenuGroupLabel>
          <MenuItem>Default</MenuItem>
          <MenuItem inset variant="destructive">
            Destructive
          </MenuItem>
          <MenuCheckboxItem checked>Checkbox</MenuCheckboxItem>
          <MenuCheckboxItem checked={false} variant="switch">
            Switch
          </MenuCheckboxItem>
          <MenuRadioGroup value="one">
            <MenuRadioItem value="one">One</MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuShortcut>⌘K</MenuShortcut>
          <MenuSub>
            <MenuSubTrigger inset>More</MenuSubTrigger>
            <MenuSubPopup>Sub default</MenuSubPopup>
            <MenuSubPopup align="center" alignOffset={7} sideOffset={2}>
              Sub centered
            </MenuSubPopup>
          </MenuSub>
        </MenuGroup>
      </Menu>,
    );

    expect(markup).toContain("Destructive");
    expect(propsFor("CheckboxItem")).toHaveLength(2);
    expect(propsFor("Positioner")).toHaveLength(4);
    expect(propsFor("SubmenuTrigger")[0]?.["data-inset"]).toBe(true);
  });

  it("renders popover tooltip and viewport variants", () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverPopup viewportClassName="viewport">Default</PopoverPopup>
        <PopoverPopup
          align="end"
          alignOffset={2}
          side="top"
          sideOffset={9}
          tooltipStyle
          viewportClassName="tooltip-viewport"
        >
          Tooltip
        </PopoverPopup>
        <PopoverTitle>Title</PopoverTitle>
        <PopoverDescription>Description</PopoverDescription>
        <PopoverClose>Close</PopoverClose>
      </Popover>,
    );

    expect(propsFor("Positioner")).toHaveLength(2);
    expect(propsFor("Viewport")[1]?.className).toContain("tooltip-viewport");
    expect(propsFor("Popup")[1]?.className).toContain("w-fit");
  });

  it("renders select button, popup width, and indicator branches", () => {
    const markup = render(
      <>
        <SelectButton>Default button</SelectButton>
        <SelectButton render={<a href="#choice" />} variant="ghost">
          Ghost button
        </SelectButton>
        <Select defaultValue="one">
          <SelectTrigger size="sm" variant="ghost">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectGroup>
              <SelectGroupLabel>Group</SelectGroupLabel>
              <SelectItem value="one">One</SelectItem>
              <SelectItem hideIndicator value="two">
                Two
              </SelectItem>
              <SelectSeparator />
            </SelectGroup>
          </SelectPopup>
          <SelectPopup matchTriggerWidth={false} popupClassName="narrow">
            Empty
          </SelectPopup>
        </Select>
      </>,
    );

    expect(markup).toContain("Ghost button");
    expect(propsFor("Positioner")).toHaveLength(2);
    expect(propsFor("ItemIndicator")).toHaveLength(1);
    expect(propsFor("ItemText")).toHaveLength(2);
  });
});
