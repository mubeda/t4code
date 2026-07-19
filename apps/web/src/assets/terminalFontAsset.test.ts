// @effect-diagnostics nodeBuiltinImport:off - The test verifies the checked-in binary font asset.
import * as NodeFS from "node:fs";

import { create } from "fontkitten";
import { describe, expect, it } from "vite-plus/test";

const assetDirectory = new URL("./fonts/jetbrains-mono-nerd-font/", import.meta.url);

describe("bundled terminal Nerd Font asset", () => {
  it("uses one monospaced font for text, Powerline, and Nerd glyphs", () => {
    const parsed = create(
      NodeFS.readFileSync(new URL("JetBrainsMonoNerdFontMono-Regular.woff2", assetDirectory)),
    );
    if (parsed.isCollection) {
      throw new Error("Expected a single monospaced Nerd Font.");
    }

    expect(parsed.hasGlyphForCodePoint(0x4d)).toBe(true);
    expect(parsed.hasGlyphForCodePoint(0xe0b0)).toBe(true);
    expect(parsed.hasGlyphForCodePoint(0xf115)).toBe(true);
    expect(parsed.hasGlyphForCodePoint(0xf0001)).toBe(true);

    const textAdvanceWidth = parsed.glyphForCodePoint(0x4d).advanceWidth;
    expect(parsed.glyphForCodePoint(0xe0b0).advanceWidth).toBe(textAdvanceWidth);
    expect(parsed.glyphForCodePoint(0xf115).advanceWidth).toBe(textAdvanceWidth);
    expect(parsed.glyphForCodePoint(0xf0001).advanceWidth).toBe(textAdvanceWidth);
  });

  it("records pinned provenance and includes the upstream license", () => {
    const source = NodeFS.readFileSync(new URL("SOURCE.md", assetDirectory), "utf8");
    const license = NodeFS.readFileSync(new URL("LICENSE", assetDirectory), "utf8");

    expect(source).toContain("Nerd Fonts v3.4.0");
    expect(source).toContain("JetBrainsMonoNerdFontMono-Regular.ttf");
    expect(license.length).toBeGreaterThan(1_000);
  });
});
