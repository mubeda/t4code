import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ toggles: [] as Array<Record<string, unknown>> }));

vi.mock("../ui/toggle", () => ({
  Toggle: (props: Record<string, unknown>) => {
    harness.toggles.push(props);
    return (
      <button aria-label={props["aria-label"] as string}>
        {props.children as React.ReactNode}
      </button>
    );
  },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

import { PanelLayoutControls, RightPanelMaximizeControl } from "./PanelLayoutControls";

beforeEach(() => {
  harness.toggles.length = 0;
});

describe("PanelLayoutControls", () => {
  it("renders available controls with optional shortcuts", () => {
    const onToggleTerminal = vi.fn();
    const onToggleRightPanel = vi.fn();
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        terminalAvailable
        terminalOpen
        terminalShortcutLabel="Ctrl+J"
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        onToggleTerminal={onToggleTerminal}
        onToggleRightPanel={onToggleRightPanel}
      />,
    );

    expect(markup).toContain("Toggle terminal drawer (Ctrl+J)");
    expect(markup).toContain("Toggle right panel");
    (harness.toggles[0]!.onPressedChange as () => void)();
    (harness.toggles[1]!.onPressedChange as () => void)();
    expect(onToggleTerminal).toHaveBeenCalledOnce();
    expect(onToggleRightPanel).toHaveBeenCalledOnce();
  });

  it("explains unavailable controls", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel="Ctrl+Shift+P"
        onToggleTerminal={vi.fn()}
        onToggleRightPanel={vi.fn()}
      />,
    );
    expect(markup).toContain("Terminal drawer is unavailable");
    expect(markup).toContain("Right panel is unavailable");
    expect(harness.toggles).toEqual([
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: true }),
    ]);
  });

  it("formats available controls without shortcuts and a right-panel shortcut", () => {
    const withoutShortcuts = renderToStaticMarkup(
      <PanelLayoutControls
        terminalAvailable
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen
        rightPanelShortcutLabel="Ctrl+Shift+P"
        onToggleTerminal={vi.fn()}
        onToggleRightPanel={vi.fn()}
      />,
    );
    expect(withoutShortcuts).toContain("Toggle terminal drawer");
    expect(withoutShortcuts).toContain("Toggle right panel (Ctrl+Shift+P)");
  });
});

describe("RightPanelMaximizeControl", () => {
  it("switches between maximize and restore presentations", () => {
    expect(
      renderToStaticMarkup(<RightPanelMaximizeControl maximized={false} onToggle={vi.fn()} />),
    ).toContain("Maximize panel");
    harness.toggles.length = 0;
    expect(
      renderToStaticMarkup(<RightPanelMaximizeControl maximized onToggle={vi.fn()} />),
    ).toContain("Restore panel size");
  });
});
