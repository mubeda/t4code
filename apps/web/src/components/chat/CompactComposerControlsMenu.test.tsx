import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  radioGroups: [] as Array<Record<string, unknown>>,
  menuItems: [] as Array<Record<string, unknown>>,
}));

vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button>{props.children as React.ReactNode}</button>,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children, render }: { children?: React.ReactNode; render?: React.ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  MenuPopup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MenuRadioGroup: (props: Record<string, unknown>) => {
    harness.radioGroups.push(props);
    return <>{props.children as React.ReactNode}</>;
  },
  MenuRadioItem: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  MenuSeparator: () => <hr />,
  MenuItem: (props: Record<string, unknown>) => {
    harness.menuItems.push(props);
    return <button>{props.children as React.ReactNode}</button>;
  },
}));

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";

beforeEach(() => {
  harness.radioGroups.length = 0;
  harness.menuItems.length = 0;
});

function render(overrides: Partial<React.ComponentProps<typeof CompactComposerControlsMenu>> = {}) {
  const props: React.ComponentProps<typeof CompactComposerControlsMenu> = {
    activePlan: true,
    interactionMode: "default",
    planSidebarLabel: "Plan",
    planSidebarOpen: false,
    runtimeMode: "approval-required",
    showInteractionModeToggle: true,
    traitsMenuContent: <span>Traits</span>,
    onToggleInteractionMode: vi.fn(),
    onTogglePlanSidebar: vi.fn(),
    onRuntimeModeChange: vi.fn(),
    ...overrides,
  };
  return { markup: renderToStaticMarkup(<CompactComposerControlsMenu {...props} />), props };
}

function change(group: Record<string, unknown>, value: string): void {
  (group.onValueChange as (next: string) => void)(value);
}

describe("CompactComposerControlsMenu", () => {
  it("renders all optional controls and forwards meaningful changes", () => {
    const { markup, props } = render();

    expect(markup).toContain("Traits");
    expect(markup).toContain("Chat");
    expect(markup).toContain("Supervised");
    expect(markup).toContain("Show plan sidebar");
    change(harness.radioGroups[0]!, "");
    change(harness.radioGroups[0]!, "default");
    change(harness.radioGroups[0]!, "plan");
    expect(props.onToggleInteractionMode).toHaveBeenCalledOnce();
    change(harness.radioGroups[1]!, "");
    change(harness.radioGroups[1]!, "approval-required");
    change(harness.radioGroups[1]!, "full-access");
    expect(props.onRuntimeModeChange).toHaveBeenCalledWith("full-access");
    (harness.menuItems[0]!.onClick as () => void)();
    expect(props.onTogglePlanSidebar).toHaveBeenCalledOnce();
  });

  it("hides optional sections and formats the open sidebar action", () => {
    const { markup } = render({
      activePlan: false,
      planSidebarOpen: true,
      showInteractionModeToggle: false,
      traitsMenuContent: undefined,
    });

    expect(markup).not.toContain("Traits");
    expect(markup).not.toContain("Mode");
    expect(markup).not.toContain("sidebar");
    expect(harness.radioGroups).toHaveLength(1);

    const open = render({ planSidebarOpen: true, traitsMenuContent: undefined }).markup;
    expect(open).toContain("Hide plan sidebar");
  });
});
