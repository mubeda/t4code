import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  revealed: false,
  nextRevealed: null as boolean | null,
  triggerProps: null as Record<string, unknown> | null,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
  useState: () => [
    harness.revealed,
    (update: (current: boolean) => boolean) => {
      harness.nextRevealed = update(harness.revealed);
    },
  ],
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: (props: Record<string, unknown>) => {
    harness.triggerProps = props;
    return <>{props.render as React.ReactNode}</>;
  },
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

import { RedactedSensitiveText } from "./RedactedSensitiveText";

beforeEach(() => {
  harness.revealed = false;
  harness.nextRevealed = null;
  harness.triggerProps = null;
});

function render(value: string | null | undefined): string {
  return renderToStaticMarkup(
    <RedactedSensitiveText
      value={value}
      ariaLabel="Sensitive account"
      revealTooltip="Reveal account"
      hideTooltip="Hide account"
      className="extra-class"
    />,
  );
}

describe("RedactedSensitiveText", () => {
  it("hides absent and whitespace-only values", () => {
    expect(render(undefined)).toBe("");
    expect(render(null)).toBe("");
    expect(render("   ")).toBe("");
  });

  it("renders a deterministic placeholder while preserving separators", () => {
    const first = render("name@example-test_value.com");
    const second = render("name@example-test_value.com");

    expect(first).toBe(second);
    expect(first).toMatch(/[a-z0-9]+@[a-z0-9]+-[a-z0-9]+_[a-z0-9]+\.[a-z0-9]+/);
    expect(first).toContain("Reveal account");
    expect(first).not.toContain("name@example-test_value.com");
  });

  it("reveals the value and toggles back to redacted", () => {
    harness.revealed = true;
    const markup = render(" user@example.com ");

    expect(markup).toContain("user@example.com");
    expect(markup).toContain("Hide account");
    if (!harness.triggerProps) throw new Error("Expected a tooltip trigger");
    const button = (harness.triggerProps.render as React.ReactElement).props as {
      onClick: () => void;
    };
    button.onClick();
    expect(harness.nextRevealed).toBe(false);
  });
});
