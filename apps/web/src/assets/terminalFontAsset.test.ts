// @effect-diagnostics nodeBuiltinImport:off - The test verifies the checked-in binary font asset.
import { readFileSync } from "node:fs";

import { create } from "fontkitten";
import { describe, expect, it } from "vite-plus/test";

const assetDirectory = new URL("./fonts/nerd-fonts-symbols/", import.meta.url);

describe("bundled terminal Nerd Font asset", () => {
  it("contains Powerline, Nerd private-use, and supplementary-plane glyphs", () => {
    const parsed = create(
      readFileSync(new URL("SymbolsNerdFontMono-Regular.woff2", assetDirectory)),
    );
    if (parsed.isCollection) {
      throw new Error("Expected a single monospaced Nerd symbols font.");
    }

    expect(parsed.hasGlyphForCodePoint(0xe0b0)).toBe(true);
    expect(parsed.hasGlyphForCodePoint(0xf115)).toBe(true);
    expect(parsed.hasGlyphForCodePoint(0xf0001)).toBe(true);
  });

  it("records pinned provenance and includes the upstream license", () => {
    const source = readFileSync(new URL("SOURCE.md", assetDirectory), "utf8");
    const license = readFileSync(new URL("LICENSE", assetDirectory), "utf8");

    expect(source).toContain("Nerd Fonts v3.4.0");
    expect(source).toContain(
      "8efa6ba89f0a1f3eefde028f36aa64a13e36282e15ea0ca6929c664501037467",
    );
    expect(license.length).toBeGreaterThan(1_000);
  });
});
