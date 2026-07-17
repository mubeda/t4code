import { describe, expect, it } from "vite-plus/test";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  compactPartialHunkOffsets,
  fnv1a32,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getRenderablePatch", () => {
  it("compacts partial hunk render offsets for virtualized review diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,4 +48,4 @@",
      " context",
      "-before",
      "+after",
      " context",
      " context",
      "@@ -80,3 +80,4 @@",
      " context",
      "+added",
      " context",
      " context",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review", {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it("retains source-file offsets for checkpoint diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,1 +48,1 @@",
      "-before",
      "+after",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "checkpoint");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });

  it("returns null for absent content and raw text for unsupported patches", () => {
    expect(getRenderablePatch(undefined)).toBeNull();
    expect(getRenderablePatch("   ")).toBeNull();
    expect(getRenderablePatch("plain text")).toEqual({
      kind: "raw",
      text: "plain text",
      reason: "Unsupported diff format. Showing raw patch.",
    });
  });

  it("leaves complete files unchanged and compacts partial files without cache keys", () => {
    const complete = { isPartial: false } as never;
    expect(compactPartialHunkOffsets(complete)).toBe(complete);
    const partial = {
      isPartial: true,
      cacheKey: undefined,
      hunks: [
        { splitLineCount: 2, unifiedLineCount: 3, splitLineStart: 10, unifiedLineStart: 20 },
        { splitLineCount: 4, unifiedLineCount: 5, splitLineStart: 30, unifiedLineStart: 40 },
      ],
      splitLineCount: 0,
      unifiedLineCount: 0,
    } as never;
    expect(compactPartialHunkOffsets(partial)).toMatchObject({
      splitLineCount: 6,
      unifiedLineCount: 8,
      hunks: [
        { splitLineStart: 0, unifiedLineStart: 0 },
        { splitLineStart: 2, unifiedLineStart: 3 },
      ],
    });
  });
});

describe("diff rendering metadata helpers", () => {
  it("resolves themes, hashes, paths, and render-key fallbacks", () => {
    expect(resolveDiffThemeName("dark")).toBe("pierre-dark");
    expect(resolveDiffThemeName("light")).toBe("pierre-light");
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("abc", 1, 3)).not.toBe(fnv1a32("abc"));
    expect(resolveFileDiffPath({ name: "a/src/app.ts" } as never)).toBe("src/app.ts");
    expect(resolveFileDiffPath({ name: "b/src/app.ts" } as never)).toBe("src/app.ts");
    expect(resolveFileDiffPath({ name: null, prevName: "old.ts" } as never)).toBe("old.ts");
    expect(resolveFileDiffPath({ name: null, prevName: null } as never)).toBe("");
    expect(buildFileDiffRenderKey({ cacheKey: "cached" } as never)).toBe("cached");
    expect(
      buildFileDiffRenderKey({ cacheKey: null, prevName: null, name: "new.ts" } as never),
    ).toBe("none:new.ts");
  });

  it.each([
    ["new", "addition"],
    ["deleted", "deletion"],
    ["change", "modified"],
    ["rename-pure", "modified"],
    ["rename-changed", "modified"],
    ["unknown", "muted"],
  ])("maps %s diff collapse colors", (type, expected) => {
    expect(getDiffCollapseIconClassName({ type } as never)).toContain(expected);
  });
});
