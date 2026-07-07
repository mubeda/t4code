import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";

const h = vi.hoisted(() => ({
  nativeEngineAvailable: true,
  emptyTokens: false,
  createHighlighterCore: vi.fn(),
  createNativeEngine: vi.fn(() => ({ __engine: "native" })),
  createJavaScriptRegexEngine: vi.fn(() => ({ __engine: "javascript" })),
  tokenizeCalls: [] as Array<{
    readonly code: string;
    readonly options: { readonly lang: string; readonly theme: string };
  }>,
}));

vi.mock("@shikijs/core", () => ({
  createHighlighterCore: (options: unknown) => h.createHighlighterCore(options),
}));

vi.mock("@shikijs/engine-javascript", () => ({
  createJavaScriptRegexEngine: () => h.createJavaScriptRegexEngine(),
}));

vi.mock("react-native-shiki-engine", () => ({
  isNativeEngineAvailable: () => h.nativeEngineAvailable,
  createNativeEngine: () => h.createNativeEngine(),
}));

type HighlighterModule = typeof import("./nativeReviewDiffHighlighter");

async function loadModule(): Promise<HighlighterModule> {
  return import("./nativeReviewDiffHighlighter");
}

function lineRow(
  id: string,
  fileId: string,
  content: string,
  change: NativeReviewDiffRow["change"] = "add",
): NativeReviewDiffRow {
  return { kind: "line", id, fileId, content, change };
}

function diffFile(id: string, language: NativeReviewDiffFile["language"] = "typescript"): NativeReviewDiffFile {
  return { id, path: `${id}.ts`, language, additions: 0, deletions: 0 };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  h.nativeEngineAvailable = true;
  h.emptyTokens = false;
  h.tokenizeCalls.length = 0;
  h.createNativeEngine.mockClear();
  h.createJavaScriptRegexEngine.mockClear();
  h.createHighlighterCore.mockReset();
  h.createHighlighterCore.mockImplementation((options: unknown) =>
    Promise.resolve({
      codeToTokensBase: (
        code: string,
        tokenizeOptions: { readonly lang: string; readonly theme: string },
      ) => {
        h.tokenizeCalls.push({ code, options: tokenizeOptions });
        if (h.emptyTokens) {
          return [];
        }
        return code
          .split("\n")
          .map((lineText) => [{ content: lineText, color: "#abcabc", fontStyle: 2 }]);
      },
      __options: options,
    }),
  );
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("getNativeReviewDiffHighlighter: javascript engine", () => {
  it("creates and caches the javascript highlighter", async () => {
    const mod = await loadModule();
    const handle = await mod.getNativeReviewDiffHighlighter("javascript");

    expect(handle.engine).toBe("javascript");
    expect(h.createJavaScriptRegexEngine).toHaveBeenCalledTimes(1);
    expect(h.createHighlighterCore).toHaveBeenCalledTimes(1);

    const again = await mod.getNativeReviewDiffHighlighter("javascript");
    expect(again).toBe(handle);
    expect(h.createHighlighterCore).toHaveBeenCalledTimes(1);
  });

  it("wraps a javascript initialization failure and retries after reset", async () => {
    const mod = await loadModule();
    h.createHighlighterCore.mockImplementationOnce(() => Promise.reject(new Error("js boom")));

    const error = await mod.getNativeReviewDiffHighlighter("javascript").catch((cause) => cause);
    expect(error._tag).toBe("NativeReviewDiffHighlighterInitializationError");
    expect(error.requestedEngine).toBe("javascript");
    expect(error.attemptedEngine).toBe("javascript");
    expect(String(error.message)).toContain("javascript");

    const handle = await mod.getNativeReviewDiffHighlighter("javascript");
    expect(handle.engine).toBe("javascript");
    expect(h.createHighlighterCore).toHaveBeenCalledTimes(2);
  });
});

describe("getNativeReviewDiffHighlighter: native engine", () => {
  it("creates the native highlighter when the native engine is available", async () => {
    const mod = await loadModule();
    const handle = await mod.getNativeReviewDiffHighlighter();

    expect(handle.engine).toBe("native");
    expect(h.createNativeEngine).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to javascript when the native engine is unavailable", async () => {
    h.nativeEngineAvailable = false;
    const mod = await loadModule();

    const handle = await mod.getNativeReviewDiffHighlighter("native");
    expect(handle.engine).toBe("javascript");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to javascript when native initialization throws a generic error", async () => {
    const mod = await loadModule();
    h.createHighlighterCore.mockImplementationOnce(() => Promise.reject(new Error("native boom")));

    const handle = await mod.getNativeReviewDiffHighlighter("native");
    expect(handle.engine).toBe("javascript");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("throws an aggregate error when both native and javascript fail, then retries", async () => {
    const mod = await loadModule();
    h.createHighlighterCore.mockImplementation(() => Promise.reject(new Error("all boom")));

    const error = await mod.getNativeReviewDiffHighlighter("native").catch((cause) => cause);
    expect(error._tag).toBe("NativeReviewDiffHighlighterInitializationError");
    expect(error.requestedEngine).toBe("native");
    expect(error.attemptedEngine).toBe("javascript");
    expect(error.cause).toBeInstanceOf(AggregateError);

    h.createHighlighterCore.mockImplementation((options: unknown) =>
      Promise.resolve({
        codeToTokensBase: () => [],
        __options: options,
      }),
    );
    const handle = await mod.getNativeReviewDiffHighlighter("native");
    expect(handle.engine).toBe("native");
  });
});

describe("highlightNativeReviewDiffVisibleRows", () => {
  const files = [diffFile("f1"), diffFile("f2")];
  const rows: ReadonlyArray<NativeReviewDiffRow> = [
    { kind: "file", id: "f1:header", fileId: "f1" },
    lineRow("f1:l0", "f1", "line a"),
    lineRow("f1:l1", "f1", "line b", "context"),
    lineRow("f2:l0", "f2", "line c"),
  ];

  it("tokenizes the visible line rows keyed by row id", async () => {
    const mod = await loadModule();
    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows,
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 3,
    });

    expect(result.engine).toBe("javascript");
    expect(Object.keys(result.tokensByRowId).sort()).toEqual(["f1:l0", "f1:l1", "f2:l0"]);
    expect(result.rowCount).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.tokensByRowId["f1:l0"]?.[0]?.content).toBe("line a");
    expect(h.tokenizeCalls[0]?.options.theme).toBe("t3-pierre-dark");
    // one tokenize segment per file
    expect(h.tokenizeCalls).toHaveLength(2);
  });

  it("uses the light theme name for the light scheme", async () => {
    const mod = await loadModule();
    await mod.highlightNativeReviewDiffVisibleRows({
      rows,
      files,
      scheme: "light",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 3,
    });
    expect(h.tokenizeCalls[0]?.options.theme).toBe("t3-pierre-light");
  });

  it("returns an empty result when the signal is already aborted", async () => {
    const mod = await loadModule();
    const controller = new AbortController();
    controller.abort();

    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows,
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 3,
      signal: controller.signal,
    });

    expect(result.tokensByRowId).toEqual({});
    expect(result.rowCount).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  it("skips rows that were already highlighted", async () => {
    const mod = await loadModule();
    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows,
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 3,
      alreadyHighlightedRowIds: new Set(["f1:l0", "f2:l0"]),
    });
    expect(Object.keys(result.tokensByRowId)).toEqual(["f1:l1"]);
  });

  it("respects the maxRows limit", async () => {
    const mod = await loadModule();
    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows,
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 3,
      maxRows: 1,
    });
    expect(result.rowCount).toBe(1);
  });

  it("clamps out-of-range row indices", async () => {
    const mod = await loadModule();
    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows,
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: -50,
      lastRowIndex: 500,
      overscanRows: 0,
    });
    expect(result.rowCount).toBe(3);
  });

  it("skips line rows whose file is unknown", async () => {
    const mod = await loadModule();
    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows: [lineRow("orphan:l0", "missing", "orphan line")],
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 0,
    });
    expect(result.tokensByRowId).toEqual({});
    expect(result.rowCount).toBe(0);
  });

  it("falls back to plain tokens when the highlighter returns no lines", async () => {
    h.emptyTokens = true;
    const mod = await loadModule();
    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows: [lineRow("f1:l0", "f1", ""), lineRow("f1:l1", "f1", "content")],
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 1,
    });
    expect(result.tokensByRowId["f1:l0"]).toEqual([{ content: " ", color: null, fontStyle: null }]);
    expect(result.tokensByRowId["f1:l1"]).toEqual([
      { content: "content", color: null, fontStyle: null },
    ]);
  });

  it("returns zero rows when there are no rows to highlight", async () => {
    const mod = await loadModule();
    const result = await mod.highlightNativeReviewDiffVisibleRows({
      rows: [],
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: 0,
    });
    expect(result.rowCount).toBe(0);
  });
});

describe("streamNativeReviewDiffTokens", () => {
  const files = [diffFile("f1"), diffFile("f2")];

  it("streams tokens in chunks per file", async () => {
    const mod = await loadModule();
    const chunks: Array<{
      readonly chunkIndex: number;
      readonly fileId: string;
      readonly lineCount: number;
      readonly rowIds: ReadonlyArray<string>;
    }> = [];

    const engine = await mod.streamNativeReviewDiffTokens({
      rows: [
        lineRow("f1:l0", "f1", "a"),
        lineRow("f1:l1", "f1", "b"),
        lineRow("f1:l2", "f1", "c"),
        lineRow("f2:l0", "f2", "d"),
      ],
      files,
      scheme: "dark",
      engine: "javascript",
      chunkSize: 2,
      onChunk: (chunk) => {
        chunks.push({
          chunkIndex: chunk.chunkIndex,
          fileId: chunk.fileId,
          lineCount: chunk.lineCount,
          rowIds: Object.keys(chunk.tokensByRowId),
        });
      },
    });

    expect(engine).toBe("javascript");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, fileId: "f1", lineCount: 2 });
    expect(chunks[1]).toMatchObject({ chunkIndex: 1, fileId: "f1", lineCount: 1 });
    expect(chunks[2]).toMatchObject({ chunkIndex: 2, fileId: "f2", lineCount: 1 });
    expect(chunks[0]?.rowIds).toEqual(["f1:l0", "f1:l1"]);
  });

  it("returns without emitting when the signal is aborted", async () => {
    const mod = await loadModule();
    const controller = new AbortController();
    controller.abort();
    const onChunk = vi.fn();

    const engine = await mod.streamNativeReviewDiffTokens({
      rows: [lineRow("f1:l0", "f1", "a")],
      files,
      scheme: "dark",
      engine: "javascript",
      signal: controller.signal,
      onChunk,
    });

    expect(engine).toBe("javascript");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("emits fallback tokens when the highlighter returns no lines", async () => {
    h.emptyTokens = true;
    const mod = await loadModule();
    let captured: Record<string, ReadonlyArray<{ content: string }>> = {};

    await mod.streamNativeReviewDiffTokens({
      rows: [lineRow("f1:l0", "f1", "content")],
      files: [diffFile("f1")],
      scheme: "dark",
      engine: "javascript",
      onChunk: (chunk) => {
        captured = chunk.tokensByRowId as typeof captured;
      },
    });

    expect(captured["f1:l0"]).toEqual([{ content: "content", color: null, fontStyle: null }]);
  });

  it("ignores line rows missing content and files without rows", async () => {
    const mod = await loadModule();
    const onChunk = vi.fn();

    await mod.streamNativeReviewDiffTokens({
      rows: [
        { kind: "line", id: "f1:noContent", fileId: "f1" },
        lineRow("f1:l0", "f1", "kept"),
      ],
      files: [diffFile("f1"), diffFile("f2")],
      scheme: "dark",
      engine: "javascript",
      onChunk,
    });

    // one chunk for f1 (only the row with content), none for the empty f2
    expect(onChunk).toHaveBeenCalledTimes(1);
    const chunk = onChunk.mock.calls[0]?.[0] as { readonly tokensByRowId: Record<string, unknown> };
    expect(Object.keys(chunk.tokensByRowId)).toEqual(["f1:l0"]);
  });
});
