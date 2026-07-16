import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  primitiveProps: [] as Array<{ name: string; props: Record<string, unknown> }>,
  scrollProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@base-ui/react/dialog", async () => {
  const React = await import("react");
  const primitive = (name: string) => (props: Record<string, unknown>) => {
    harness.primitiveProps.push({ name, props });
    return React.createElement(
      "div",
      { "data-primitive": name },
      props.render as React.ReactNode,
      props.children as React.ReactNode,
    );
  };
  return {
    Dialog: {
      Root: primitive("Root"),
      Portal: primitive("Portal"),
      Trigger: primitive("Trigger"),
      Close: primitive("Close"),
      Backdrop: primitive("Backdrop"),
      Viewport: primitive("Viewport"),
      Popup: primitive("Popup"),
      Title: primitive("Title"),
      Description: primitive("Description"),
    },
  };
});
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
  Sheet,
  SheetBackdrop,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from "./sheet";

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

describe("sheet UI wrappers", () => {
  it("renders primitive aliases and basic wrappers", () => {
    render(
      <Sheet open>
        <SheetPortal>
          <SheetTrigger>Open</SheetTrigger>
          <SheetClose>Dismiss</SheetClose>
          <SheetBackdrop className="backdrop" />
          <SheetTitle className="title">Title</SheetTitle>
          <SheetDescription className="description">Description</SheetDescription>
        </SheetPortal>
      </Sheet>,
    );
    expect(propsFor("Root")).toHaveLength(1);
    expect(propsFor("Backdrop")[0]?.className).toContain("backdrop");
    expect(propsFor("Title")[0]).toMatchObject({ "data-slot": "sheet-title" });
  });

  it.each(["bottom", "top", "left", "right"] as const)(
    "renders a %s popup and viewport",
    (side) => {
      const markup = render(
        <SheetPopup side={side} variant={side === "left" ? "inset" : "default"}>
          {side}
        </SheetPopup>,
      );
      expect(markup).toContain(side);
      expect(propsFor("Viewport")[0]?.className).toContain(
        side === "bottom"
          ? "grid-rows-[1fr_auto]"
          : side === "top"
            ? "grid-rows-[auto_1fr]"
            : side === "left"
              ? "justify-start"
              : "justify-end",
      );
      expect(propsFor("Popup")[0]?.className).toContain(
        side === "bottom"
          ? "translate-y-8"
          : side === "top"
            ? "-translate-y-8"
            : side === "left"
              ? "-translate-x-8"
              : "translate-x-8",
      );
      expect(propsFor("Close")[0]).toMatchObject({ "aria-label": "Close" });
    },
  );

  it("supports defaults and hides the popup close action", () => {
    render(
      <SheetPopup showCloseButton={false} keepMounted variant="inset">
        No close
      </SheetPopup>,
    );
    expect(propsFor("Portal")[0]?.keepMounted).toBe(true);
    expect(propsFor("Viewport")[0]?.className).toContain("justify-end");
    expect(propsFor("Close")).toHaveLength(0);
  });

  it("renders headers, footer variants, and panel scrolling", () => {
    const markup = render(
      <>
        <SheetHeader className="header">Header</SheetHeader>
        <SheetFooter>Default footer</SheetFooter>
        <SheetFooter variant="bare">Bare footer</SheetFooter>
        <SheetPanel className="panel">Panel</SheetPanel>
        <SheetPanel scrollFade={false}>Static panel</SheetPanel>
      </>,
    );
    expect(markup).toContain("Default footer");
    expect(markup).toContain("Bare footer");
    expect(markup).toContain("border-t");
    expect(harness.scrollProps[0]?.scrollFade).toBe(true);
    expect(harness.scrollProps[1]?.scrollFade).toBe(false);
  });
});
