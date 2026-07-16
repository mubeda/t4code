import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, unknown>>,
  menuItems: [] as Array<Record<string, unknown>>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  memo: (component: unknown) => component,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children, render }: { children: React.ReactNode; render: React.ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: (props: Record<string, unknown>) => {
    harness.menuItems.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("../ui/spinner", () => ({
  Spinner: () => <span data-spinner />,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

type Props = React.ComponentProps<typeof ComposerPrimaryActions>;

const defaults: Props = {
  compact: false,
  pendingAction: null,
  isRunning: false,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: vi.fn(),
  onInterrupt: vi.fn(),
  onImplementPlanInNewThread: vi.fn(),
};

function renderActions(overrides: Partial<Props> = {}): { tree: ReactElement; markup: string } {
  const component = ComposerPrimaryActions as unknown as (props: Props) => ReactElement;
  const tree = component({ ...defaults, ...overrides });
  return { tree, markup: renderToStaticMarkup(tree) };
}

function invoke(props: Record<string, unknown>, key: string, ...args: unknown[]): void {
  const handler = props[key];
  if (typeof handler !== "function") throw new Error(`Missing ${key} handler`);
  handler(...args);
}

beforeEach(() => {
  harness.buttons.length = 0;
  harness.menuItems.length = 0;
  vi.mocked(defaults.onPreviousPendingQuestion).mockReset();
  vi.mocked(defaults.onInterrupt).mockReset();
  vi.mocked(defaults.onImplementPlanInNewThread).mockReset();
});

describe("ComposerPrimaryActions", () => {
  it("renders pending-question navigation in compact and full layouts", () => {
    const full = renderActions({
      pendingAction: {
        questionIndex: 1,
        isLastQuestion: false,
        canAdvance: true,
        isResponding: false,
        isComplete: false,
      },
    });
    expect(full.markup).toContain("Previous");
    expect(full.markup).toContain("Next question");
    expect(harness.buttons[1]?.disabled).toBe(false);

    harness.buttons.length = 0;
    const compact = renderActions({
      compact: true,
      pendingAction: {
        questionIndex: 2,
        isLastQuestion: false,
        canAdvance: false,
        isResponding: false,
        isComplete: false,
      },
    });
    expect(harness.buttons[0]?.["aria-label"]).toBe("Previous question");
    expect(compact.markup).toContain("Next");
    expect(harness.buttons[1]?.disabled).toBe(true);
    invoke(harness.buttons[0]!, "onClick");
    expect(defaults.onPreviousPendingQuestion).toHaveBeenCalledOnce();
  });

  it("disables pending submissions for every blocking state", () => {
    const cases: Array<Partial<Props>> = [
      {
        pendingAction: {
          questionIndex: 0,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: false,
          isComplete: false,
        },
      },
      {
        pendingAction: {
          questionIndex: 1,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: true,
          isComplete: true,
        },
      },
      {
        isEnvironmentUnavailable: true,
        pendingAction: {
          questionIndex: 0,
          isLastQuestion: false,
          canAdvance: true,
          isResponding: false,
          isComplete: false,
        },
      },
    ];
    for (const value of cases) {
      harness.buttons.length = 0;
      renderActions(value);
      expect(harness.buttons.at(-1)?.disabled).toBe(true);
    }

    harness.buttons.length = 0;
    renderActions({
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: false,
        isResponding: false,
        isComplete: true,
      },
    });
    expect(harness.buttons[0]?.disabled).toBe(false);
  });

  it("interrupts a running response and preserves composer focus", () => {
    const { tree, markup } = renderActions({
      isRunning: true,
      preserveComposerFocusOnPointerDown: true,
    });
    expect(markup).toContain("Stop generation");
    const props = tree.props as Record<string, unknown>;
    const preventDefault = vi.fn();
    invoke(props, "onPointerDown", { preventDefault });
    invoke(props, "onClick");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(defaults.onInterrupt).toHaveBeenCalledOnce();
  });

  it("refines plan follow-ups with every busy-state combination", () => {
    const cases = [
      { compact: false, isSendBusy: false, isConnecting: false, isEnvironmentUnavailable: false },
      { compact: true, isSendBusy: true, isConnecting: false, isEnvironmentUnavailable: false },
      { compact: false, isSendBusy: false, isConnecting: true, isEnvironmentUnavailable: false },
      { compact: false, isSendBusy: false, isConnecting: false, isEnvironmentUnavailable: true },
    ];
    for (const value of cases) {
      harness.buttons.length = 0;
      const { markup } = renderActions({
        showPlanFollowUpPrompt: true,
        promptHasText: true,
        ...value,
      });
      expect(markup).toContain(value.isSendBusy || value.isConnecting ? "Sending..." : "Refine");
      expect(harness.buttons[0]?.disabled).toBe(
        value.isSendBusy || value.isConnecting || value.isEnvironmentUnavailable,
      );
    }
  });

  it("implements plans in place or in a new thread", () => {
    const cases = [
      { isSendBusy: false, isConnecting: false, isEnvironmentUnavailable: false },
      { isSendBusy: true, isConnecting: false, isEnvironmentUnavailable: false },
      { isSendBusy: false, isConnecting: true, isEnvironmentUnavailable: false },
      { isSendBusy: false, isConnecting: false, isEnvironmentUnavailable: true },
    ];
    for (const value of cases) {
      harness.buttons.length = 0;
      harness.menuItems.length = 0;
      const { markup } = renderActions({ showPlanFollowUpPrompt: true, ...value });
      expect(markup).toContain(value.isSendBusy || value.isConnecting ? "Sending..." : "Implement");
      expect(harness.buttons[0]?.disabled).toBe(
        value.isSendBusy || value.isConnecting || value.isEnvironmentUnavailable,
      );
    }
    invoke(harness.menuItems[0]!, "onClick");
    expect(defaults.onImplementPlanInNewThread).toHaveBeenCalledOnce();
  });

  it("labels and disables ordinary sends by highest-priority state", () => {
    const cases = [
      { expected: "Send message" },
      { isEnvironmentUnavailable: true, expected: "Environment disconnected" },
      { isConnecting: true, expected: "Connecting" },
      { isPreparingWorktree: true, expected: "Preparing worktree" },
      { isSendBusy: true, expected: "Sending" },
      { hasSendableContent: false, expected: "Send message" },
    ];
    for (const value of cases) {
      const { tree, markup } = renderActions(value);
      expect((tree.props as Record<string, unknown>)["aria-label"]).toBe(value.expected);
      const busy = value.isConnecting || value.isSendBusy;
      expect(markup.includes("data-spinner")).toBe(Boolean(busy));
    }

    expect(
      (
        renderActions({
          isEnvironmentUnavailable: true,
          isConnecting: true,
          isPreparingWorktree: true,
          isSendBusy: true,
        }).tree.props as Record<string, unknown>
      )["aria-label"],
    ).toBe("Environment disconnected");
  });
});
