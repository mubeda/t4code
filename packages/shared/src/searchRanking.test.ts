import { describe, expect, it } from "vite-plus/test";

import {
  compareRankedSearchResults,
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from "./searchRanking.ts";

describe("normalizeSearchQuery", () => {
  it("trims and lowercases queries", () => {
    expect(normalizeSearchQuery("  UI  ")).toBe("ui");
  });

  it("can strip leading trigger characters", () => {
    expect(normalizeSearchQuery("  $ui", { trimLeadingPattern: /^\$+/ })).toBe("ui");
  });

  it("normalizes empty and trigger-only queries", () => {
    expect(normalizeSearchQuery("   ")).toBe("");
    expect(normalizeSearchQuery("$$", { trimLeadingPattern: /^\$+/ })).toBe("");
  });
});

describe("scoreQueryMatch", () => {
  it("prefers exact matches over broader contains matches", () => {
    expect(
      scoreQueryMatch({
        value: "ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
      }),
    ).toBe(0);

    expect(
      scoreQueryMatch({
        value: "building native ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 20,
        includesBase: 30,
      }),
    ).toBeGreaterThan(0);
  });

  it("treats boundary matches as stronger than generic contains matches", () => {
    const boundaryScore = scoreQueryMatch({
      value: "gh-fix-ci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });
    const containsScore = scoreQueryMatch({
      value: "highfixci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });

    expect(boundaryScore).not.toBeNull();
    expect(containsScore).not.toBeNull();
    expect(boundaryScore!).toBeLessThan(containsScore!);
  });

  it("rejects missing values and queries", () => {
    const bases = { exactBase: 0, prefixBase: 10 };
    expect(scoreQueryMatch({ value: "", query: "ui", ...bases })).toBeNull();
    expect(scoreQueryMatch({ value: "ui", query: "", ...bases })).toBeNull();
  });

  it("scores prefix, default boundary, includes, and fuzzy tiers", () => {
    expect(scoreQueryMatch({ value: "preview", query: "pre", exactBase: 0, prefixBase: 10 })).toBe(
      14,
    );
    expect(
      scoreQueryMatch({ value: "fix/preview", query: "preview", exactBase: 0, boundaryBase: 20 }),
    ).toBe(32);
    expect(
      scoreQueryMatch({ value: "xxpreview", query: "preview", exactBase: 0, includesBase: 30 }),
    ).toBe(36);
    expect(
      scoreQueryMatch({ value: "provider-skill", query: "psk", exactBase: 0, fuzzyBase: 100 }),
    ).not.toBeNull();
  });

  it("uses the earliest matching custom boundary and returns null when no tier matches", () => {
    expect(
      scoreQueryMatch({
        value: "x query /query",
        query: "query",
        exactBase: 0,
        boundaryBase: 20,
        boundaryMarkers: ["/", "x "],
      }),
    ).toBe(33);
    expect(
      scoreQueryMatch({
        value: "x query /query",
        query: "query",
        exactBase: 0,
        boundaryBase: 20,
        boundaryMarkers: ["x ", "/"],
      }),
    ).toBe(33);
    expect(
      scoreQueryMatch({
        value: "unrelated",
        query: "xyz",
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 20,
        includesBase: 30,
        fuzzyBase: 40,
        boundaryMarkers: [":"],
      }),
    ).toBeNull();
    expect(scoreQueryMatch({ value: "unrelated", query: "xyz", exactBase: 0 })).toBeNull();
  });

  it("caps length penalties for long values", () => {
    expect(
      scoreQueryMatch({
        value: `a${"x".repeat(100)}`,
        query: "a",
        exactBase: 0,
        prefixBase: 5,
      }),
    ).toBe(69);
  });
});

describe("scoreSubsequenceMatch", () => {
  it("scores tighter subsequences ahead of looser ones", () => {
    const compact = scoreSubsequenceMatch("ghfixci", "gfc");
    const spread = scoreSubsequenceMatch("github-fix-ci", "gfc");

    expect(compact).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(compact!).toBeLessThan(spread!);
  });

  it("handles empty, absent, leading, and long subsequences", () => {
    expect(scoreSubsequenceMatch("anything", "")).toBe(0);
    expect(scoreSubsequenceMatch("abc", "z")).toBeNull();
    expect(scoreSubsequenceMatch("-abc", "abc")).toBeGreaterThan(0);
    expect(scoreSubsequenceMatch(`a${"x".repeat(100)}`, "a")).toBe(64);
  });
});

describe("compareRankedSearchResults", () => {
  it("orders by score and then by tie breaker", () => {
    expect(
      compareRankedSearchResults(
        { item: "later", score: 2, tieBreaker: "a" },
        { item: "earlier", score: 1, tieBreaker: "z" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareRankedSearchResults(
        { item: "a", score: 1, tieBreaker: "a" },
        { item: "b", score: 1, tieBreaker: "b" },
      ),
    ).toBeLessThan(0);
    expect(
      compareRankedSearchResults(
        { item: "a", score: 1, tieBreaker: "same" },
        { item: "b", score: 1, tieBreaker: "same" },
      ),
    ).toBe(0);
  });
});

describe("insertRankedSearchResult", () => {
  it("keeps the best-ranked candidates within the limit", () => {
    const ranked = [
      { item: "b", score: 20, tieBreaker: "b" },
      { item: "d", score: 40, tieBreaker: "d" },
    ];

    insertRankedSearchResult(ranked, { item: "a", score: 10, tieBreaker: "a" }, 2);
    insertRankedSearchResult(ranked, { item: "c", score: 30, tieBreaker: "c" }, 2);

    expect(ranked.map((entry) => entry.item)).toEqual(["a", "b"]);
    expect(compareRankedSearchResults(ranked[0]!, ranked[1]!)).toBeLessThan(0);
  });

  it("handles zero limits, spare capacity, full-list rejection, and replacement", () => {
    const ranked = [{ item: "b", score: 20, tieBreaker: "b" }];
    insertRankedSearchResult(ranked, { item: "ignored", score: 0, tieBreaker: "a" }, 0);
    expect(ranked.map((entry) => entry.item)).toEqual(["b"]);

    insertRankedSearchResult(ranked, { item: "d", score: 40, tieBreaker: "d" }, 3);
    insertRankedSearchResult(ranked, { item: "c", score: 30, tieBreaker: "c" }, 2);
    expect(ranked.map((entry) => entry.item)).toEqual(["b", "c"]);

    insertRankedSearchResult(ranked, { item: "z", score: 99, tieBreaker: "z" }, 2);
    expect(ranked.map((entry) => entry.item)).toEqual(["b", "c"]);
    insertRankedSearchResult(ranked, { item: "a", score: 10, tieBreaker: "a" }, 2);
    expect(ranked.map((entry) => entry.item)).toEqual(["a", "b"]);
  });

  it("inserts before a missing entry in a sparse ranked list", () => {
    const ranked: Array<{ item: string; score: number; tieBreaker: string }> = [];
    ranked.length = 1;
    insertRankedSearchResult(ranked, { item: "present", score: 1, tieBreaker: "present" }, 2);
    expect(ranked[0]?.item).toBe("present");
  });
});
