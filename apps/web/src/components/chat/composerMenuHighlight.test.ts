import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  const items = [{ id: "top" }, { id: "second" }, { id: "third" }] as const;

  it("defaults to the first item when nothing is highlighted", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: null,
        currentSearchKey: "skill:u",
        highlightedSearchKey: null,
      }),
    ).toBe("top");
  });

  it("preserves the highlighted item within the same query", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:u",
        highlightedSearchKey: "skill:u",
      }),
    ).toBe("second");
  });

  it("resets to the top result when the query changes", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:u",
      }),
    ).toBe("top");
  });

  it("falls back to the first item when the highlighted item disappears", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "missing",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:ui",
      }),
    ).toBe("top");
  });

  it("prefers an exact match when no same-search highlight can be preserved", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "reference:planner",
        highlightedSearchKey: "reference:plan",
        preferredItemId: "third",
      }),
    ).toBe("third");
  });

  it("preserves a same-search highlight ahead of the preferred exact match", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "reference:planner",
        highlightedSearchKey: "reference:planner",
        preferredItemId: "third",
      }),
    ).toBe("second");
  });

  it("ignores a preferred item that is not present", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: null,
        currentSearchKey: "reference:planner",
        highlightedSearchKey: null,
        preferredItemId: "missing",
      }),
    ).toBe("top");
  });
});
