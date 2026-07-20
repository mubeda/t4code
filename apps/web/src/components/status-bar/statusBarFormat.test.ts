import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatCpuPercent,
  formatMemoryBytes,
  formatProviderWindowLabel,
  formatRemainingPercent,
  providerUsageBarColorClass,
} from "./statusBarFormat";

describe("statusBarFormat", () => {
  it("formats provider quota as remaining percentage", () => {
    expect(formatRemainingPercent(11)).toBe("89%");
    expect(formatRemainingPercent(0)).toBe("100%");
    expect(formatRemainingPercent(100)).toBe("0%");
  });

  it("formats common provider windows", () => {
    expect(formatProviderWindowLabel({ windowMinutes: 300 })).toBe("5h");
    expect(formatProviderWindowLabel({ windowMinutes: 10080 })).toBe("wk");
    expect(formatProviderWindowLabel({ windowMinutes: 43200 })).toBe("mo");
  });

  it("formats resource metrics for the compact bar", () => {
    expect(formatMemoryBytes(736_300_000)).toBe("702.2 MB");
    expect(formatMemoryBytes(1_610_612_736)).toBe("1.5 GB");
    expect(formatCpuPercent(3.456)).toBe("3.5%");
    expect(formatCpuPercent(-3.456)).toBe("0.0%");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "formats non-finite CPU metrics as unavailable",
    (cpuPercent) => {
      expect(formatCpuPercent(cpuPercent)).toBe("Unavailable");
    },
  );

  it("uses Orca-style bar colors based on remaining quota", () => {
    expect(providerUsageBarColorClass(10)).toContain("emerald");
    expect(providerUsageBarColorClass(75)).toContain("yellow");
    expect(providerUsageBarColorClass(90)).toContain("red");
  });

  it("keeps reset timestamps out of window labels", () => {
    expect(
      formatProviderWindowLabel({
        windowMinutes: 300,
        resetsAt: DateTime.makeUnsafe("2026-07-07T20:00:00.000Z"),
      }),
    ).toBe("5h");
  });
});
