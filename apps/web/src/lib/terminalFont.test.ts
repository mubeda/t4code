import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetTerminalFontLoaderForTests,
  ensureBundledTerminalFontLoaded,
  isCustomTerminalFontAvailable,
  normalizeCustomTerminalFontFamily,
  resolveTerminalFontFamily,
  TERMINAL_NERD_SYMBOLS_FONT_FAMILY,
} from "./terminalFont";

describe("resolveTerminalFontFamily", () => {
  it("uses bundled JetBrains Mono with the Nerd symbols fallback by default", () => {
    expect(resolveTerminalFontFamily({ mode: "bundled" })).toBe(
      '"JetBrains Mono", "T4Code Symbols Nerd Font Mono", monospace',
    );
  });

  it("uses the system monospace generic before the bundled symbols", () => {
    expect(resolveTerminalFontFamily({ mode: "system" })).toBe(
      'ui-monospace, "T4Code Symbols Nerd Font Mono", monospace',
    );
  });

  it("quotes a custom family and keeps deterministic fallbacks", () => {
    expect(
      resolveTerminalFontFamily({
        mode: "custom",
        family: 'Operator "Mono" \\ Local',
      }),
    ).toBe(
      '"Operator \\"Mono\\" \\\\ Local", "T4Code Symbols Nerd Font Mono", "JetBrains Mono", monospace',
    );
  });

  it("normalizes valid custom families and rejects invalid CSS stacks", () => {
    expect(normalizeCustomTerminalFontFamily("  Maple Mono  ")).toBe("Maple Mono");
    expect(normalizeCustomTerminalFontFamily("")).toBeNull();
    expect(normalizeCustomTerminalFontFamily("Maple Mono, monospace")).toBeNull();
    expect(normalizeCustomTerminalFontFamily("Maple\u0000Mono")).toBeNull();
  });
});

describe("custom font availability", () => {
  it("uses the client FontFaceSet as a best-effort device-local check", () => {
    const check = vi.fn(() => false);

    expect(isCustomTerminalFontAvailable("Missing Mono", { check })).toBe(false);
    expect(check).toHaveBeenCalledWith('12px "Missing Mono"');
  });

  it("returns unknown when a FontFaceSet is unavailable", () => {
    expect(isCustomTerminalFontAvailable("Missing Mono", null)).toBeNull();
  });
});

describe("bundled font loading", () => {
  beforeEach(() => {
    __resetTerminalFontLoaderForTests();
  });

  it("loads the symbol probe once for all terminal instances", async () => {
    const load = vi.fn(() => Promise.resolve([]));
    const fontSet = { load };

    await Promise.all([
      ensureBundledTerminalFontLoaded(fontSet),
      ensureBundledTerminalFontLoaded(fontSet),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(
      `12px "${TERMINAL_NERD_SYMBOLS_FONT_FAMILY}"`,
      "\ue0b0\uf115\u{f0001}",
    );
  });

  it("warns once and resolves when the asset cannot load", async () => {
    const load = vi.fn(() => Promise.reject(new Error("font unavailable")));
    const warn = vi.fn();

    await ensureBundledTerminalFontLoaded({ load }, warn);
    await ensureBundledTerminalFontLoaded({ load }, warn);

    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
