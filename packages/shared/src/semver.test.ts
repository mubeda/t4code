import { describe, expect, it } from "vite-plus/test";

import {
  compareSemverVersions,
  normalizeSemverVersion,
  parseSemver,
  satisfiesSemverRange,
} from "./semver.ts";

describe("semver helpers", () => {
  it("matches supported range groups", () => {
    const range = "^22.16 || ^23.11 || >=24.10";

    expect(satisfiesSemverRange("22.16.0", range)).toBe(true);
    expect(satisfiesSemverRange("23.11.1", range)).toBe(true);
    expect(satisfiesSemverRange("24.10.0", range)).toBe(true);
    expect(satisfiesSemverRange("22.15.9", range)).toBe(false);
    expect(satisfiesSemverRange("23.10.9", range)).toBe(false);
    expect(satisfiesSemverRange("24.9.9", range)).toBe(false);
  });

  it("normalizes versions with a missing patch segment", () => {
    expect(normalizeSemverVersion("2.1")).toBe("2.1.0");
  });

  it("normalizes whitespace, empty segments, and prerelease suffixes", () => {
    expect(normalizeSemverVersion(" 2 . 1 . 3-beta.1 ")).toBe("2.1.3-beta.1");
    expect(normalizeSemverVersion("2..1")).toBe("2.1.0");
    expect(normalizeSemverVersion("2.1.3")).toBe("2.1.3");
  });

  it("parses complete versions and trims non-empty prerelease identifiers", () => {
    expect(parseSemver("v2.1.3-alpha.. 2 ")).toEqual({
      major: 2,
      minor: 1,
      patch: 3,
      prerelease: ["alpha", "2"],
    });
    expect(parseSemver("2.1.3")).toEqual({
      major: 2,
      minor: 1,
      patch: 3,
      prerelease: [],
    });
  });

  it("rejects incomplete, overlong, nonnumeric, and non-finite versions", () => {
    expect(parseSemver("1")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("x.2.3")).toBeNull();
    expect(parseSemver("1.x.3")).toBeNull();
    expect(parseSemver("1.2.x")).toBeNull();
    expect(parseSemver(`${"9".repeat(400)}.2.3`)).toBeNull();
  });

  it("compares prerelease versions before stable versions", () => {
    expect(compareSemverVersions("2.1.111-beta.1", "2.1.111")).toBeLessThan(0);
  });

  it("falls back to lexical comparison for malformed numeric segments", () => {
    expect(compareSemverVersions("1.2.3abc", "1.2.10")).toBeGreaterThan(0);
    expect(compareSemverVersions("1.2.3", "malformed")).toBeLessThan(0);
  });

  it("compares major, minor, and patch versions", () => {
    expect(compareSemverVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemverVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemverVersions("1.1.2", "1.1.1")).toBeGreaterThan(0);
    expect(compareSemverVersions("1.1.1", "1.1.1")).toBe(0);
  });

  it("orders numeric and lexical prerelease identifiers", () => {
    expect(compareSemverVersions("1.0.0-1", "1.0.0-2")).toBeLessThan(0);
    expect(compareSemverVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareSemverVersions("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0);
    expect(compareSemverVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareSemverVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemverVersions("1.0.0-alpha.1", "1.0.0-alpha")).toBeGreaterThan(0);
    expect(compareSemverVersions("1.0.0-alpha.1", "1.0.0-alpha.1")).toBe(0);
    expect(compareSemverVersions("1.0.0", "1.0.0-alpha")).toBeGreaterThan(0);
  });

  it("supports comparison comparators", () => {
    expect(satisfiesSemverRange("24.9.0", ">=24.0 <24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", ">=24.0 <24.10")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", ">24.9")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", ">24.10")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", "<=24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.1", "<=24.10")).toBe(false);
    expect(satisfiesSemverRange("24.9.9", "<24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", "=24.10.0")).toBe(true);
    expect(satisfiesSemverRange("24.10.1", "=24.10.0")).toBe(false);
  });

  it("compares every numeric component and accepts abbreviated versions", () => {
    expect(satisfiesSemverRange("25", ">24.99.99")).toBe(true);
    expect(satisfiesSemverRange("23.99.99", ">24")).toBe(false);
    expect(satisfiesSemverRange("24.11", ">24.10.99")).toBe(true);
    expect(satisfiesSemverRange("24.9.99", ">24.10")).toBe(false);
    expect(satisfiesSemverRange("24.10.2-beta.1", ">24.10.1")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", ">24.10.1")).toBe(false);
  });

  it("honors caret range upper bounds for zero-major versions", () => {
    expect(satisfiesSemverRange("1.2.2", "^1.2.3")).toBe(false);
    expect(satisfiesSemverRange("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfiesSemverRange("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.2.3", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.5.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("1.2.3", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesSemverRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("rejects invalid versions and unsupported range syntax", () => {
    expect(satisfiesSemverRange("not-a-version", ">=24.0")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", "~24.10")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", "   ")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", ">=24.10 || nonsense")).toBe(true);
    expect(satisfiesSemverRange("9007199254740993.0.0", "=9007199254740992.0.0")).toBe(false);
  });

  it("uses equality for a comparator without an explicit operator", () => {
    expect(satisfiesSemverRange("24.10.0", "24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.1", "24.10")).toBe(false);
  });

  it("keeps the range checker stringifiable and executable as plain JavaScript", () => {
    const source = satisfiesSemverRange.toString();
    const recreated = Function(`return (${source});`)() as typeof satisfiesSemverRange;

    expect(source).toContain("function satisfiesSemverRange");
    expect(source).not.toContain(": string");
    expect(source).not.toContain(": boolean");
    expect(recreated("24.10.0", ">=24.10")).toBe(true);
    expect(recreated("24.9.9", ">=24.10")).toBe(false);
  });
});
