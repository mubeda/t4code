import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  triggers: [] as Array<Record<string, unknown>>,
}));

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: (props: Record<string, unknown>) => {
    harness.triggers.push(props);
    return <>{props.render as React.ReactNode}</>;
  },
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

import { ContextWindowMeter } from "./ContextWindowMeter";

function usage(overrides: Record<string, unknown> = {}) {
  return {
    usedTokens: 500,
    maxTokens: 1_000,
    usedPercentage: 50,
    totalProcessedTokens: null,
    compactsAutomatically: false,
    ...overrides,
  } as never;
}

function render(overrides: Record<string, unknown> = {}, providerDisplayName?: string | null) {
  return renderToStaticMarkup(
    <ContextWindowMeter
      usage={usage(overrides)}
      {...(providerDisplayName !== undefined ? { providerDisplayName } : {})}
    />,
  );
}

beforeEach(() => {
  harness.triggers.length = 0;
});

describe("ContextWindowMeter", () => {
  it("renders ordinary and low percentage formats", () => {
    expect(render()).toContain("Context window 50% used");
    expect(render({ usedPercentage: 9 })).toContain("Context window 9% used");
    expect(render({ usedPercentage: 9.25 })).toContain("Context window 9.3% used");
    expect(render({ usedPercentage: 10.6 })).toContain("Context window 11% used");
    expect(harness.triggers[0]).toMatchObject({ openOnHover: true, delay: 150, closeDelay: 0 });
  });

  it("falls back to token labels for missing or invalid percentages", () => {
    expect(render({ usedPercentage: null, maxTokens: null })).toContain(
      "Context window 500 tokens used",
    );
    expect(render({ usedPercentage: Number.NaN, maxTokens: 1_000 })).toContain(
      "Context window 500 tokens used",
    );
  });

  it("clamps progress widths and changes color above ninety percent", () => {
    const negative = render({ usedPercentage: -5 });
    expect(negative).toContain("width:0%");
    expect(negative).toContain("var(--color-blue-500)");

    const overloaded = render({ usedPercentage: 105 });
    expect(overloaded).toContain("width:100%");
    expect(overloaded).toContain("var(--color-red-500)");
    expect(overloaded).toContain('aria-valuenow="100"');

    expect(render({ usedPercentage: null, maxTokens: 1_000 })).toContain("width:0%");
  });

  it("shows processed totals only when positive", () => {
    expect(render({ totalProcessedTokens: 12_500 })).toContain("Total processed");
    expect(render({ totalProcessedTokens: 12_500 })).toContain("13k");
    expect(render({ totalProcessedTokens: 0 })).not.toContain("Total processed");
    expect(render({ totalProcessedTokens: null })).not.toContain("Total processed");
  });

  it("explains automatic compaction with provider and fallback names", () => {
    expect(render({ compactsAutomatically: true }, "Codex")).toContain(
      "Codex automatically compacts",
    );
    expect(render({ compactsAutomatically: true }, null)).toContain("It automatically compacts");
    expect(render({ compactsAutomatically: false }, "Codex")).not.toContain(
      "automatically compacts",
    );
  });

  it("omits progress details when no maximum is known", () => {
    const markup = render({ maxTokens: null, usedPercentage: null, usedTokens: 1_250 });
    expect(markup).toContain("1.3k");
    expect(markup).not.toContain('role="progressbar"');

    const changingUsage = usage();
    let reads = 0;
    Object.defineProperty(changingUsage, "maxTokens", {
      get: () => {
        reads += 1;
        return reads === 3 ? null : 1_000;
      },
    });
    renderToStaticMarkup(<ContextWindowMeter usage={changingUsage} />);
  });
});
