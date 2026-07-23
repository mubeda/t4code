import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { UsageWindowViewModel } from "./providerUsagePresentation";
import { ProviderUsageWindowMeter } from "./ProviderUsageWindowMeter";

function windowViewModel(overrides: Partial<UsageWindowViewModel> = {}): UsageWindowViewModel {
  return {
    key: "session",
    label: "Session",
    windowLabel: "5h",
    consumedPercent: 72,
    displayedPercent: 28,
    fillPercent: 28,
    percentageLabel: "28% remaining",
    resetLabel: "Resets in 5m",
    resetsAt: null,
    resetDescription: null,
    barColorClass: "bg-yellow-500",
    ...overrides,
  };
}

describe("ProviderUsageWindowMeter", () => {
  it("labels the window with its percentage, reset, and non-color warning state", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageWindowMeter variant="detail" window={windowViewModel()} />,
    );

    expect(markup).toContain('aria-label="Session: 28% remaining; Resets in 5m; Caution"');
    expect(markup).toContain("28% remaining");
    expect(markup).toContain("Resets in 5m");
    expect(markup).toContain("Caution");
  });

  it("clamps the rendered fill width", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageWindowMeter
        variant="detail"
        window={windowViewModel({ displayedPercent: 140, fillPercent: 140 })}
      />,
    );

    expect(markup).toContain("width:100%");
  });

  it("derives detail urgency from consumed usage rather than displayed remaining usage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageWindowMeter
        variant="detail"
        window={windowViewModel({ consumedPercent: 84, displayedPercent: 16, fillPercent: 16 })}
      />,
    );

    expect(markup).toContain("bg-destructive");
    expect(markup).toContain("Critical");
    expect(markup).not.toContain("bg-warning");
  });

  it("keeps footer meters neutral even for urgent consumed usage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageWindowMeter
        variant="footer"
        window={windowViewModel({ consumedPercent: 84 })}
      />,
    );

    expect(markup).toContain("bg-foreground");
    expect(markup).not.toContain("bg-warning");
    expect(markup).not.toContain("bg-destructive");
    expect(markup).toContain("Critical");
  });

  it("keeps footer percentage copy compact and non-wrapping", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageWindowMeter variant="footer" window={windowViewModel()} />,
    );

    expect(markup).toContain("28% left");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain('aria-label="Session: 28% remaining; Resets in 5m; Caution"');
  });
});
