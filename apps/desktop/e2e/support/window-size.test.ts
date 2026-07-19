import { describe, expect, it } from "vite-plus/test";

import { scaleDesktopUiWindowSize } from "./window-size.ts";

describe("scaleDesktopUiWindowSize", () => {
  it("keeps CSS pixels unchanged on standard-density runners", () => {
    expect(scaleDesktopUiWindowSize({ width: 960, height: 640 }, 1)).toEqual({
      width: 960,
      height: 640,
    });
  });

  it("converts CSS pixels to physical pixels on Retina macOS runners", () => {
    expect(scaleDesktopUiWindowSize({ width: 960, height: 640 }, 2)).toEqual({
      width: 1_920,
      height: 1_280,
    });
  });

  it("rounds fractional device-pixel ratios up to preserve the requested viewport", () => {
    expect(scaleDesktopUiWindowSize({ width: 1_001, height: 721 }, 1.25)).toEqual({
      width: 1_252,
      height: 902,
    });
  });
});
