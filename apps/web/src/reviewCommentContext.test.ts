import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import {
  appendReviewCommentsToPrompt,
  buildDiffReviewComment,
  buildFileReviewComment,
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  formatReviewCommentContext,
  hasReviewCommentMessageSegments,
  inferReviewCommentFenceLanguage,
  parseReviewCommentMessageSegments,
  restoreDiffReviewCommentRange,
} from "./reviewCommentContext";

describe("review comment context parsing", () => {
  it("extracts comment metadata, user text, and fenced diff without raw wrapper text", () => {
    const segments = parseReviewCommentMessageSegments(
      [
        'Before <review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
        "Wadduo",
        "```diff",
        "@@ -0,0 +47,2 @@",
        '+  it("keeps valid zero-usage snapshots", () => {',
        "+    expect(snapshot).not.toBeNull();",
        "```",
        "</review_comment> after",
      ].join("\n"),
    );

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("Before"),
      }),
    );
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "apps/web/src/lib/contextWindow.test.ts",
          rangeLabel: "+47 to +58",
          text: "Wadduo",
          diff: expect.stringContaining('it("keeps valid zero-usage snapshots"'),
        }),
      }),
    );
    expect(segments[2]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: " after",
      }),
    );
  });

  it("wraps hunk-only review diffs in a renderable file patch", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="s" filePath="src/app.ts" startIndex="0" endIndex="0">',
        "Please check this.",
        "```diff",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment?.kind).toBe("review-comment");
    if (segment?.kind !== "review-comment") return;

    expect(buildReviewCommentRenderablePatch(segment.comment)).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
  });

  it("formats editable file comments with the review-comment contract", () => {
    const comment = buildFileReviewComment({
      id: "comment-1",
      filePath: "src/app.ts",
      startLine: 2,
      endLine: 3,
      text: "Keep this configurable.",
      contents: ["one", "two", "three", "four"].join("\n"),
    });
    const prompt = appendReviewCommentsToPrompt("Please update this.", [comment]);
    const segments = parseReviewCommentMessageSegments(prompt);

    expect(segments).toHaveLength(2);
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "src/app.ts",
          startIndex: 1,
          endIndex: 2,
          rangeLabel: "L2 to L3",
          text: "Keep this configurable.",
          diff: "two\nthree",
          fenceLanguage: "ts",
        }),
      }),
    );
    expect(prompt).toContain("```ts\ntwo\nthree\n```");
  });

  it("formats mixed diff-side selections with the review-comment contract", () => {
    const [fileDiff] = parsePatchFiles(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,4 +1,4 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        " four",
      ].join("\n"),
      "review-comment-test",
    )[0]!.files;

    const comment = buildDiffReviewComment({
      id: "comment-2",
      sectionId: "turn:2",
      sectionTitle: "Turn 2",
      filePath: "src/app.ts",
      fileDiff: fileDiff!,
      range: {
        start: 2,
        side: "deletions",
        end: 2,
        endSide: "additions",
      },
      text: "Keep this compatible.",
    });

    expect(comment).toEqual(
      expect.objectContaining({
        sectionId: "turn:2",
        sectionTitle: "Turn 2",
        filePath: "src/app.ts",
        startIndex: 1,
        endIndex: 2,
        rangeLabel: "2",
        text: "Keep this compatible.",
        diff: "@@ -2,1 +2,1 @@\n-two\n+TWO",
        fenceLanguage: "diff",
      }),
    );
  });

  it("uses file extensions for source comments and preserves nested markdown fences", () => {
    expect(inferReviewCommentFenceLanguage("docs/plan.md")).toBe("md");
    expect(inferReviewCommentFenceLanguage("src/view.tsx")).toBe("tsx");

    const serialized = formatReviewCommentContext({
      id: "comment-3",
      sectionId: "file:docs/plan.md",
      sectionTitle: "File comment",
      filePath: "docs/plan.md",
      startIndex: 0,
      endIndex: 2,
      rangeLabel: "L1 to L3",
      text: "Update this example.",
      diff: ["# Example", "```ts", "const value = 1;", "```"].join("\n"),
      fenceLanguage: "md",
    });
    const [segment] = parseReviewCommentMessageSegments(serialized);

    expect(serialized).toContain("````md");
    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          fenceLanguage: "md",
          diff: ["# Example", "```ts", "const value = 1;", "```"].join("\n"),
        }),
      }),
    );
  });

  it("round-trips greater-than signs in attributes", () => {
    const serialized = formatReviewCommentContext({
      id: "comment-4",
      sectionId: "turn:4",
      sectionTitle: "Changes > 5",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "+1",
      text: "Check this.",
      diff: "@@ -0,0 +1,1 @@\n+one",
      fenceLanguage: "diff",
    });
    const [segment] = parseReviewCommentMessageSegments(serialized);

    expect(serialized).toContain('sectionTitle="Changes &gt; 5"');
    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({ sectionTitle: "Changes > 5" }),
      }),
    );
  });

  it("keeps fenced examples in comment text separate from the final context fence", () => {
    const text = ["Try this:", "```ts", "const value = 1;", "```", "Then retry."].join("\n");
    const serialized = formatReviewCommentContext({
      id: "comment-5",
      sectionId: "turn:5",
      sectionTitle: "Turn 5",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "+1",
      text,
      diff: "@@ -0,0 +1,1 @@\n+one",
      fenceLanguage: "diff",
    });
    const [segment] = parseReviewCommentMessageSegments(serialized);

    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          text,
          diff: "@@ -0,0 +1,1 @@\n+one",
          fenceLanguage: "diff",
        }),
      }),
    );
  });

  it("restores Pierre line selections from persisted diff comment row indexes", () => {
    const fileDiff = parsePatchFiles(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
      ].join("\n"),
      "restore-review-comment-range",
    )[0]!.files[0]!;
    const comment = buildDiffReviewComment({
      id: "comment-6",
      sectionId: "turn:6",
      sectionTitle: "Turn 6",
      filePath: "src/app.ts",
      fileDiff,
      range: { start: 2, side: "deletions", end: 2, endSide: "additions" },
      text: "Keep both sides.",
    });

    expect(comment).not.toBeNull();
    expect(restoreDiffReviewCommentRange(fileDiff, comment!)).toEqual({
      start: 2,
      side: "deletions",
      end: 2,
      endSide: "additions",
    });
  });

  describe("malformed and fallback inputs", () => {
    it("preserves invalid review blocks and rejects incomplete numeric attributes", () => {
      const invalid = [
        '<review_comment sectionId="s" filePath="a.ts" startIndex="x" endIndex="2">body</review_comment>',
        '<review_comment sectionId="" filePath="a.ts" startIndex="1" endIndex="2">body</review_comment>',
        '<review_comment sectionId="s" filePath="" startIndex="1" endIndex="2">body</review_comment>',
      ].join("between");
      const segments = parseReviewCommentMessageSegments(invalid);
      expect(segments.filter((segment) => segment.kind === "review-comment")).toEqual([]);
      expect(
        segments.map((segment) => (segment.kind === "text" ? segment.text : "")).join(""),
      ).toContain('startIndex="x"');
      expect(hasReviewCommentMessageSegments(invalid)).toBe(false);
      expect(parseReviewCommentMessageSegments("plain text")).toEqual([
        { kind: "text", id: "review-comment-text:0", text: "plain text" },
      ]);
    });

    it("defaults labels and fences while normalizing reversed indexes", () => {
      const value =
        '<review_comment sectionId="section" sectionTitle="" filePath="a.ts" startIndex="9" endIndex="3" rangeLabel="">note</review_comment>';
      const segments = parseReviewCommentMessageSegments(value);
      expect(hasReviewCommentMessageSegments(value)).toBe(true);
      expect(segments[0]).toMatchObject({
        kind: "review-comment",
        comment: {
          sectionTitle: "Review",
          startIndex: 3,
          endIndex: 9,
          rangeLabel: "line",
          text: "note",
          diff: "",
          fenceLanguage: "diff",
        },
      });
    });

    it("chooses a safe markdown fence longer than embedded backticks", () => {
      expect(formatReviewCommentFence("ts", "const x = 1;\n")).toBe("```ts\nconst x = 1;\n```");
      expect(formatReviewCommentFence("md", "before ```` after")).toBe(
        "`````md\nbefore ```` after\n`````",
      );
    });

    it("appends no-op, blank-prompt, and populated review blocks", () => {
      const comment = buildFileReviewComment({
        id: "file-1",
        filePath: "src/a.ts",
        startLine: 2,
        endLine: 2,
        text: " note ",
        contents: "one\ntwo\nthree",
      });
      expect(appendReviewCommentsToPrompt(" prompt ", [])).toBe(" prompt ");
      expect(appendReviewCommentsToPrompt("   ", [comment])).toBe(
        formatReviewCommentContext(comment),
      );
      expect(appendReviewCommentsToPrompt(" prompt ", [comment])).toContain(
        "prompt\n\n<review_comment",
      );
    });

    it("normalizes reversed file ranges and recognizes filename language fallbacks", () => {
      expect(
        buildFileReviewComment({
          id: "file-2",
          filePath: "src/a.ts",
          startLine: 3,
          endLine: 1,
          text: " text ",
          contents: "one\ntwo\nthree",
        }),
      ).toMatchObject({
        startIndex: 0,
        endIndex: 2,
        rangeLabel: "L1 to L3",
        text: "text",
        diff: "one\ntwo\nthree",
      });
      expect(inferReviewCommentFenceLanguage("C:\\repo\\FILE.TSX")).toBe("tsx");
      expect(inferReviewCommentFenceLanguage(".gitignore")).toBe("gitignore");
      expect(inferReviewCommentFenceLanguage("README")).toBe("text");
      expect(inferReviewCommentFenceLanguage("name.")).toBe("text");
    });

    it("returns only renderable diff patches and preserves full git patches", () => {
      const base = {
        id: "patch",
        sectionId: "s",
        sectionTitle: "S",
        filePath: "src\\a.ts",
        startIndex: 0,
        endIndex: 0,
        rangeLabel: "L1",
        text: "note",
        diff: "@@ -1,1 +1,1 @@\n-old\n+new",
      };
      expect(buildReviewCommentRenderablePatch({ ...base, fenceLanguage: "ts" })).toBe("");
      expect(buildReviewCommentRenderablePatch({ ...base, diff: "   " })).toBe("");
      expect(buildReviewCommentRenderablePatch({ ...base, fenceLanguage: undefined })).toContain(
        "diff --git a/src/a.ts b/src/a.ts",
      );
      const full = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts";
      expect(buildReviewCommentRenderablePatch({ ...base, diff: full })).toBe(full);
    });

    it("builds uniform addition and deletion labels through side fallbacks", () => {
      const additionDiff = parsePatchFiles(
        [
          "diff --git a/new.ts b/new.ts",
          "--- /dev/null",
          "+++ b/new.ts",
          "@@ -0,0 +1,2 @@",
          "+one",
          "+two",
        ].join("\n"),
        "review-additions",
      )[0]!.files[0]!;
      const addition = buildDiffReviewComment({
        id: "add",
        sectionId: "s",
        sectionTitle: "S",
        filePath: "new.ts",
        fileDiff: additionDiff,
        range: { start: 1, side: "deletions", end: 2, endSide: "deletions" },
        text: " additions ",
      });
      expect(addition).toMatchObject({ rangeLabel: "+1 to +2", text: "additions" });

      const deletionDiff = parsePatchFiles(
        [
          "diff --git a/old.ts b/old.ts",
          "--- a/old.ts",
          "+++ /dev/null",
          "@@ -1,2 +0,0 @@",
          "-one",
          "-two",
        ].join("\n"),
        "review-deletions",
      )[0]!.files[0]!;
      const deletion = buildDiffReviewComment({
        id: "delete",
        sectionId: "s",
        sectionTitle: "S",
        filePath: "old.ts",
        fileDiff: deletionDiff,
        range: { start: 1, side: "additions", end: 2, endSide: "additions" },
        text: " deletions ",
      });
      expect(deletion).toMatchObject({ rangeLabel: "-1 to -2", text: "deletions" });
    });

    it("rejects unavailable diff rows and restores context-only selections", () => {
      const contextDiff = parsePatchFiles(
        [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -4,1 +4,1 @@",
          " context",
        ].join("\n"),
        "review-context",
      )[0]!.files[0]!;
      const comment = buildDiffReviewComment({
        id: "context",
        sectionId: "s",
        sectionTitle: "S",
        filePath: "a.ts",
        fileDiff: contextDiff,
        range: { start: 4, side: "additions", end: 4 },
        text: " context ",
      });
      expect(comment).toMatchObject({ rangeLabel: "4", diff: expect.stringContaining(" context") });
      expect(restoreDiffReviewCommentRange(contextDiff, comment!)).toEqual({
        start: 4,
        side: "additions",
        end: 4,
        endSide: "additions",
      });
      expect(
        restoreDiffReviewCommentRange(contextDiff, {
          ...comment!,
          startIndex: 99,
          endIndex: 100,
        }),
      ).toBeNull();
      expect(
        buildDiffReviewComment({
          id: "missing",
          sectionId: "s",
          sectionTitle: "S",
          filePath: "a.ts",
          fileDiff: contextDiff,
          range: { start: 999, side: "additions", end: 1000 },
          text: "missing",
        }),
      ).toBeNull();
    });
  });
});
