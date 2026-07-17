import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

function render(
  additions: number,
  deletions: number,
  props: {
    showParentheses?: boolean;
    layout?: "aligned" | "inline";
    className?: string;
  } = {},
): string {
  return renderToStaticMarkup(
    <DiffStatLabel additions={additions} deletions={deletions} {...props} />,
  );
}

describe("DiffStatLabel", () => {
  it("detects additions and deletions", () => {
    expect(hasNonZeroStat({ additions: 0, deletions: 0 })).toBe(false);
    expect(hasNonZeroStat({ additions: 1, deletions: 0 })).toBe(true);
    expect(hasNonZeroStat({ additions: 0, deletions: 1 })).toBe(true);
  });

  it("renders raw and compact thousands", () => {
    expect(render(999, 1_000)).toContain("+999");
    expect(render(1_000, 1_500)).toContain("+1k");
    expect(render(1_500, 12_400)).toContain("+1.5k");
    expect(render(12_400, 1)).toContain("+12k");
  });

  it("renders compact millions and billions", () => {
    expect(render(1_000_000, 1_500_000)).toContain("+1m");
    expect(render(1_500_000, 12_400_000)).toContain("+1.5m");
    expect(render(12_400_000, 1)).toContain("+12m");
    expect(render(1_000_000_000, 1_500_000_000)).toContain("+1b");
    expect(render(1_500_000_000, 12_400_000_000)).toContain("+1.5b");
    expect(render(12_400_000_000, 1)).toContain("+12b");
  });

  it("supports inline parenthesized and default aligned layouts", () => {
    const inline = render(1, 2, {
      showParentheses: true,
      layout: "inline",
      className: "custom-stat",
    });
    expect(inline).toContain("(");
    expect(inline).toContain(")");
    expect(inline).toContain("inline-flex");
    expect(inline).toContain("custom-stat");
    expect(render(1, 2)).toContain("inline-grid");
  });
});
