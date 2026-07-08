import { describe, expect, it } from "vite-plus/test";

import type {
  ReviewParsedDiff,
  ReviewRenderableFile,
  ReviewRenderableHunkRow,
  ReviewRenderableLineRow,
} from "./reviewModel";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_STYLE,
} from "./nativeReviewDiffAdapter";

function lineRow(overrides: Partial<ReviewRenderableLineRow> = {}): ReviewRenderableLineRow {
  return {
    kind: "line",
    id: overrides.id ?? "line-id",
    change: overrides.change ?? "context",
    oldLineNumber: overrides.oldLineNumber ?? null,
    newLineNumber: overrides.newLineNumber ?? null,
    content: overrides.content ?? "",
    additionTokenIndex: overrides.additionTokenIndex ?? null,
    deletionTokenIndex: overrides.deletionTokenIndex ?? null,
    comparison: overrides.comparison ?? null,
  };
}

function hunkRow(overrides: Partial<ReviewRenderableHunkRow> = {}): ReviewRenderableHunkRow {
  return {
    kind: "hunk",
    id: overrides.id ?? "hunk-id",
    header: overrides.header ?? "@@ -1,1 +1,1 @@",
    context: overrides.context ?? null,
  };
}

function renderableFile(overrides: Partial<ReviewRenderableFile> = {}): ReviewRenderableFile {
  return {
    id: overrides.id ?? "file-1",
    cacheKey: overrides.cacheKey ?? "cache-1",
    path: overrides.path ?? "src/a.ts",
    previousPath: overrides.previousPath ?? null,
    changeType: overrides.changeType ?? "change",
    additions: overrides.additions ?? 0,
    deletions: overrides.deletions ?? 0,
    languageHint: overrides.languageHint ?? null,
    additionLines: overrides.additionLines ?? [],
    deletionLines: overrides.deletionLines ?? [],
    rows: overrides.rows ?? [],
  };
}

function filesDiff(files: ReadonlyArray<ReviewRenderableFile>): ReviewParsedDiff {
  return {
    kind: "files",
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    notice: null,
  };
}

describe("NATIVE_REVIEW_DIFF_STYLE", () => {
  it("exposes stable geometry constants", () => {
    expect(NATIVE_REVIEW_DIFF_STYLE.contentWidth).toBe(2_800);
    expect(NATIVE_REVIEW_DIFF_STYLE.changeBarWidth).toBe(4);
    expect(NATIVE_REVIEW_DIFF_STYLE.rowHeight).toBe(NATIVE_REVIEW_DIFF_STYLE.rowHeight);
  });
});

describe("createNativeReviewDiffTheme", () => {
  it("produces the dark palette", () => {
    const theme = createNativeReviewDiffTheme("dark");
    expect(theme.hunkBackground).toBe("#071f28");
    expect(theme.addBackground).toBe("#0d2f28");
    expect(theme.deleteBackground).toBe("#391415");
    expect(theme.addBar).toBe("#00cab1");
    expect(theme.addText).toBe("#5ECC71");
    expect(theme.deleteText).toBe("#FF6762");
    expect(typeof theme.background).toBe("string");
    expect(typeof theme.deleteBar).toBe("string");
  });

  it("produces the light palette", () => {
    const theme = createNativeReviewDiffTheme("light");
    expect(theme.background).toBe("#ffffff");
    expect(theme.text).toBe("#070707");
    expect(theme.hunkBackground).toBe("#e0f2ff");
    expect(theme.addBackground).toBe("#e5f8f5");
    expect(theme.deleteBackground).toBe("#ffe6e7");
    expect(theme.addText).toBe("#199F43");
    expect(theme.deleteText).toBe("#D52C36");
  });
});

describe("buildNativeReviewDiffData: non-file diffs", () => {
  it("returns an empty payload for an empty diff", () => {
    const data = buildNativeReviewDiffData({ kind: "empty" });
    expect(data.rows).toEqual([]);
    expect(data.files).toEqual([]);
    expect(data.additions).toBe(0);
    expect(data.deletions).toBe(0);
    expect(data.commentTargetsByRowId.size).toBe(0);
    expect(data.rowIdByCommentLineId.size).toBe(0);
  });

  it("returns an empty payload for a raw diff", () => {
    const data = buildNativeReviewDiffData({
      kind: "raw",
      text: "raw patch",
      reason: "unsupported",
      notice: null,
    });
    expect(data.rows).toEqual([]);
    expect(data.files).toEqual([]);
  });
});

describe("buildNativeReviewDiffData: language detection", () => {
  it("maps language hints and file extensions to native languages", () => {
    const specs: ReadonlyArray<{
      readonly id: string;
      readonly path: string;
      readonly hint: string | null;
      readonly expected: string;
    }> = [
      { id: "f1", path: "any.txt", hint: "typescript", expected: "typescript" },
      { id: "f2", path: "any.txt", hint: "TSX", expected: "tsx" },
      { id: "f3", path: "any.txt", hint: "javascript", expected: "javascript" },
      { id: "f4", path: "any.txt", hint: "jsx", expected: "jsx" },
      { id: "f5", path: "any.txt", hint: "json", expected: "json" },
      { id: "f6", path: "any.txt", hint: "yaml", expected: "yaml" },
      { id: "f7", path: "any.txt", hint: "bash", expected: "bash" },
      { id: "f8", path: "any.txt", hint: "diff", expected: "diff" },
      { id: "f9", path: "src/component.tsx", hint: null, expected: "tsx" },
      { id: "f10", path: "src/module.ts", hint: null, expected: "typescript" },
      { id: "f11", path: "src/widget.jsx", hint: null, expected: "jsx" },
      { id: "f12", path: "src/script.js", hint: null, expected: "javascript" },
      { id: "f13", path: "src/legacy.cjs", hint: null, expected: "javascript" },
      { id: "f14", path: "data/config.json", hint: null, expected: "json" },
      { id: "f15", path: "data/config.jsonc", hint: null, expected: "json" },
      { id: "f16", path: "ci/pipeline.yml", hint: null, expected: "yaml" },
      { id: "f17", path: "ci/pipeline.yaml", hint: null, expected: "yaml" },
      { id: "f18", path: "scripts/run.sh", hint: null, expected: "bash" },
      { id: "f19", path: "usr/bin/tool", hint: null, expected: "bash" },
      { id: "f20", path: "myshell-profile", hint: null, expected: "bash" },
      { id: "f21", path: "docs/readme.md", hint: "unknown", expected: "diff" },
      { id: "f22", path: "assets/logo", hint: null, expected: "diff" },
    ];
    const data = buildNativeReviewDiffData(
      filesDiff(
        specs.map((spec) =>
          renderableFile({ id: spec.id, path: spec.path, languageHint: spec.hint }),
        ),
      ),
    );

    for (const spec of specs) {
      const file = data.files.find((entry) => entry.id === spec.id);
      expect(file?.language).toBe(spec.expected);
    }
  });
});

describe("buildNativeReviewDiffData: change types and notices", () => {
  it("maps change types onto the native header row", () => {
    const cases: ReadonlyArray<{
      readonly changeType: ReviewRenderableFile["changeType"];
      readonly expected: NativeReviewDiffRow["changeType"];
    }> = [
      { changeType: "change", expected: "modified" },
      { changeType: "new", expected: "new" },
      { changeType: "deleted", expected: "deleted" },
      { changeType: "rename-changed", expected: "rename-changed" },
    ];

    for (const testCase of cases) {
      const data = buildNativeReviewDiffData(
        filesDiff([
          renderableFile({
            id: `file-${testCase.changeType}`,
            changeType: testCase.changeType,
            rows: [lineRow({ id: "r", change: "add", content: "x" })],
          }),
        ]),
      );
      const header = data.rows.find((row) => row.kind === "file");
      expect(header?.changeType).toBe(testCase.expected);
    }
  });

  it("emits a non-text notice for an empty binary diff", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([renderableFile({ id: "png", path: "assets/logo.png", rows: [] })]),
    );
    const notice = data.rows.find((row) => row.kind === "notice");
    expect(notice?.text).toBe("Unsupported format. Diff contents are not available.");
    expect(notice?.id).toBe("png:notice:non-text");
  });

  it("emits a rename notice for a pure rename with no rows", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "rn",
          path: "src/renamed.ts",
          previousPath: "src/original.ts",
          changeType: "rename-pure",
          rows: [],
        }),
      ]),
    );
    const notice = data.rows.find((row) => row.kind === "notice");
    expect(notice?.text).toBe("This file was renamed without modifications.");
    const header = data.rows.find((row) => row.kind === "file");
    expect(header?.changeType).toBe("rename-pure");
    expect(header?.previousPath).toBe("src/original.ts");
  });

  it("emits no notice when a file already has rows", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "with-rows",
          rows: [lineRow({ id: "r", change: "context", content: "ok" })],
        }),
      ]),
    );
    expect(data.rows.some((row) => row.kind === "notice")).toBe(false);
  });
});

describe("buildNativeReviewDiffData: hunks and line rows", () => {
  it("renders hunk headers with and without context", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "hunks",
          rows: [
            hunkRow({ id: "h1", header: "@@ -1,2 +1,2 @@", context: "function foo()" }),
            lineRow({ id: "l1", change: "context", content: "unchanged" }),
            hunkRow({ id: "h2", header: "@@ -10,1 +10,1 @@", context: null }),
          ],
        }),
      ]),
    );
    const hunkTexts = data.rows.filter((row) => row.kind === "hunk").map((row) => row.text);
    expect(hunkTexts).toContain("@@ -1,2 +1,2 @@ function foo()");
    expect(hunkTexts).toContain("@@ -10,1 +10,1 @@");
  });

  it("maps line rows to native rows with stable ids", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "file-1",
          rows: [lineRow({ id: "abc", change: "add", content: "added", newLineNumber: 5 })],
        }),
      ]),
    );
    const line = data.rows.find((row) => row.kind === "line");
    expect(line?.id).toBe("file-1:line:0:abc");
    expect(line?.change).toBe("add");
    expect(line?.newLineNumber).toBe(5);
    expect(data.rowIdByCommentLineId.get("abc")).toBe("file-1:line:0:abc");
    expect(data.commentTargetsByRowId.get("file-1:line:0:abc")?.filePath).toBe("src/a.ts");
  });
});

describe("buildNativeReviewDiffData: word diff ranges", () => {
  it("adds word diff ranges for a small paired change", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "wd",
          rows: [
            lineRow({ id: "d", change: "delete", content: "const value = 1;" }),
            lineRow({ id: "a", change: "add", content: "const value = 2;" }),
          ],
        }),
      ]),
    );
    const deleteRow = data.rows.find((row) => row.kind === "line" && row.change === "delete");
    const addRow = data.rows.find((row) => row.kind === "line" && row.change === "add");
    expect(deleteRow?.wordDiffRanges).toBeDefined();
    expect(addRow?.wordDiffRanges).toBeDefined();
    expect(deleteRow?.wordDiffRanges?.length ?? 0).toBeGreaterThan(0);
  });

  it("skips word diff ranges when the whole line changed", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "wd2",
          rows: [
            lineRow({ id: "d", change: "delete", content: "aaaaaaaa" }),
            lineRow({ id: "a", change: "add", content: "bbbbbbbb" }),
          ],
        }),
      ]),
    );
    const deleteRow = data.rows.find((row) => row.kind === "line" && row.change === "delete");
    const addRow = data.rows.find((row) => row.kind === "line" && row.change === "add");
    expect(deleteRow?.wordDiffRanges).toBeUndefined();
    expect(addRow?.wordDiffRanges).toBeUndefined();
  });

  it("skips word diffs when a paired line has empty content", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "wd3",
          rows: [
            lineRow({ id: "d", change: "delete", content: "" }),
            lineRow({ id: "a", change: "add", content: "value" }),
          ],
        }),
      ]),
    );
    const addRow = data.rows.find((row) => row.kind === "line" && row.change === "add");
    expect(addRow?.wordDiffRanges).toBeUndefined();
  });

  it("leaves unpaired and context runs untouched", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({
          id: "wd4",
          rows: [
            lineRow({ id: "c", change: "context", content: "context line" }),
            lineRow({ id: "d1", change: "delete", content: "only delete" }),
          ],
        }),
      ]),
    );
    const lines = data.rows.filter((row) => row.kind === "line");
    expect(lines.every((row) => row.wordDiffRanges === undefined)).toBe(true);
  });
});

describe("buildNativeReviewDiffData: inline comments", () => {
  function comment(overrides: Partial<ReviewInlineComment> = {}): ReviewInlineComment {
    return {
      id: overrides.id ?? "comment-1",
      sectionId: overrides.sectionId ?? "section-1",
      sectionTitle: overrides.sectionTitle ?? "Turn 1",
      filePath: overrides.filePath ?? "src/a.ts",
      startIndex: overrides.startIndex ?? 0,
      endIndex: overrides.endIndex ?? 0,
      rangeLabel: overrides.rangeLabel ?? "L1",
      text: overrides.text ?? "Nice change",
      diff: overrides.diff ?? "",
      ...(overrides.fenceLanguage ? { fenceLanguage: overrides.fenceLanguage } : {}),
    };
  }

  it("attaches a comment row beneath its target line", () => {
    const data = buildNativeReviewDiffData({
      parsedDiff: filesDiff([
        renderableFile({
          id: "file-1",
          path: "src/a.ts",
          rows: [lineRow({ id: "l0", change: "add", content: "line one" })],
        }),
      ]),
      comments: [comment({ id: "cmt", text: "Looks good", endIndex: 0 })],
    });
    const commentRow = data.rows.find((row) => row.kind === "comment");
    expect(commentRow?.id).toBe("cmt");
    expect(commentRow?.commentText).toBe("Looks good");
    expect(commentRow?.commentRangeLabel).toBe("L1");
    expect(commentRow?.commentSectionTitle).toBe("Turn 1");
  });

  it("clamps comment end index to the last line row", () => {
    const data = buildNativeReviewDiffData({
      parsedDiff: filesDiff([
        renderableFile({
          id: "file-1",
          path: "src/a.ts",
          rows: [
            lineRow({ id: "l0", change: "add", content: "one" }),
            lineRow({ id: "l1", change: "add", content: "two" }),
          ],
        }),
      ]),
      comments: [comment({ id: "cmt-clamp", endIndex: 999 })],
    });
    const rows = data.rows;
    const commentIndex = rows.findIndex((row) => row.kind === "comment");
    const lastLineIndex = rows.map((row) => row.kind).lastIndexOf("line");
    expect(commentIndex).toBe(lastLineIndex + 1);
  });

  it("ignores comments targeting a different file", () => {
    const data = buildNativeReviewDiffData({
      parsedDiff: filesDiff([
        renderableFile({
          id: "file-1",
          path: "src/a.ts",
          rows: [lineRow({ id: "l0", change: "add", content: "one" })],
        }),
      ]),
      comments: [comment({ id: "other", filePath: "src/other.ts" })],
    });
    expect(data.rows.some((row) => row.kind === "comment")).toBe(false);
  });

  it("ignores comments when the file has no line rows", () => {
    const data = buildNativeReviewDiffData({
      parsedDiff: filesDiff([
        renderableFile({
          id: "file-1",
          path: "src/a.ts",
          rows: [hunkRow({ id: "h", header: "@@ -0,0 +0,0 @@" })],
        }),
      ]),
      comments: [comment({ id: "orphan", endIndex: 0 })],
    });
    expect(data.rows.some((row) => row.kind === "comment")).toBe(false);
  });

  it("groups multiple comments onto the same line", () => {
    const data = buildNativeReviewDiffData({
      parsedDiff: filesDiff([
        renderableFile({
          id: "file-1",
          path: "src/a.ts",
          rows: [lineRow({ id: "l0", change: "add", content: "one" })],
        }),
      ]),
      comments: [comment({ id: "first", endIndex: 0 }), comment({ id: "second", endIndex: 0 })],
    });
    const commentIds = data.rows.filter((row) => row.kind === "comment").map((row) => row.id);
    expect(commentIds).toEqual(["first", "second"]);
  });

  it("propagates diff totals from the parsed diff", () => {
    const data = buildNativeReviewDiffData(
      filesDiff([
        renderableFile({ id: "file-1", additions: 3, deletions: 1, rows: [] }),
        renderableFile({ id: "file-2", additions: 2, deletions: 4, rows: [] }),
      ]),
    );
    expect(data.additions).toBe(5);
    expect(data.deletions).toBe(5);
    expect(data.files).toHaveLength(2);
  });
});
