import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ReviewRenderableFile, ReviewRenderableLineRow } from "./reviewModel";
import {
  clearReviewHighlightFileCache,
  getActiveReviewHighlighterEngine,
  getCachedHighlightedReviewFile,
  highlightCodeSnippet,
  highlightReviewFile,
  highlightReviewSelectedLines,
  highlightSourceFile,
  prepareReviewHighlighter,
  prepareReviewHighlighterLanguages,
  ReviewHighlighterEngineInitializationError,
  streamHighlightReviewFile,
  type ReviewHighlightFileProgress,
} from "./shikiReviewHighlighter";

function makeRenderableFile(
  input: Partial<ReviewRenderableFile> & Pick<ReviewRenderableFile, "path">,
): ReviewRenderableFile {
  return {
    id: input.path,
    cacheKey: input.path,
    previousPath: null,
    changeType: "new",
    additions: 0,
    deletions: 0,
    languageHint: null,
    additionLines: [],
    deletionLines: [],
    rows: [],
    ...input,
  };
}

function makeLineRow(
  input: Partial<ReviewRenderableLineRow> & Pick<ReviewRenderableLineRow, "id" | "content">,
): ReviewRenderableLineRow {
  return {
    kind: "line",
    change: "context",
    oldLineNumber: null,
    newLineNumber: null,
    additionTokenIndex: null,
    deletionTokenIndex: null,
    comparison: null,
    ...input,
  };
}

function joinTokenContents(
  lines: ReadonlyArray<ReadonlyArray<{ readonly content: string }>>,
): ReadonlyArray<string> {
  return lines.map((line) => line.map((token) => token.content).join(""));
}

describe("highlightReviewFile", () => {
  it("preserves one highlighted token row per diff line even without trailing newlines", async () => {
    const file = makeRenderableFile({
      path: "apps/mobile/src/example.txt",
      additionLines: [
        'const items = ["a"];',
        'expect(items).toEqual(["a"]);',
        "const next = items.map((item) => item.toUpperCase());",
        'expect(next).toContain("A");',
      ],
    });

    const highlighted = await highlightReviewFile(file, "light");

    expect(highlighted.additionLines).toHaveLength(file.additionLines.length);
    expect(highlighted.additionLines[0]?.map((token) => token.content).join("")).toBe(
      file.additionLines[0],
    );
    expect(highlighted.additionLines[1]?.map((token) => token.content).join("")).toBe(
      file.additionLines[1],
    );
    expect(highlighted.additionLines[2]?.map((token) => token.content).join("")).toBe(
      file.additionLines[2],
    );
    expect(highlighted.additionLines[3]?.map((token) => token.content).join("")).toBe(
      file.additionLines[3],
    );
  });

  it("adds word-alt diff emphasis for paired deletion and addition lines", async () => {
    const file = makeRenderableFile({
      path: "apps/mobile/src/example-inline-diff.txt",
      additionLines: ["const after = 2;"],
      deletionLines: ["const before = 1;"],
      rows: [
        {
          kind: "line",
          id: "delete-1",
          change: "delete",
          oldLineNumber: 1,
          newLineNumber: null,
          content: "const before = 1;",
          additionTokenIndex: null,
          deletionTokenIndex: 0,
          comparison: { change: "add", tokenIndex: 0 },
        },
        {
          kind: "line",
          id: "add-1",
          change: "add",
          oldLineNumber: null,
          newLineNumber: 1,
          content: "const after = 2;",
          additionTokenIndex: 0,
          deletionTokenIndex: null,
          comparison: { change: "delete", tokenIndex: 0 },
        },
      ],
    });

    const highlighted = await highlightReviewFile(file, "light");

    expect(highlighted.deletionLines[0]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted.additionLines[0]?.some((token) => token.diffHighlight === true)).toBe(true);
  });

  it("falls back to plain tokens for very long lines", async () => {
    const longLine = `const value = "${"a".repeat(1_100)}";`;
    const file = makeRenderableFile({
      path: "apps/mobile/src/example-long-line.txt",
      additionLines: [longLine],
      rows: [
        {
          kind: "line",
          id: "add-1",
          change: "add",
          oldLineNumber: null,
          newLineNumber: 1,
          content: longLine,
          additionTokenIndex: 0,
          deletionTokenIndex: null,
          comparison: null,
        },
      ],
    });

    const highlighted = await highlightReviewFile(file, "light");

    expect(highlighted.additionLines).toHaveLength(1);
    expect(highlighted.additionLines[0]).toEqual([
      {
        content: longLine,
        color: null,
        fontStyle: null,
      },
    ]);
  });

  it("highlights syntax-aware files, batching long inputs into chunks", async () => {
    const longLine = `const longValue = "${"z".repeat(1_050)}";`;
    const additionLines = [
      ...Array.from({ length: 205 }, (_, index) => `const value${index} = ${index};`),
      longLine,
      ...Array.from({ length: 5 }, (_, index) => `const tail${index} = ${index};`),
    ];
    const file = makeRenderableFile({
      path: "apps/mobile/src/chunked-example.ts",
      additionLines,
      deletionLines: ["const removed = true;"],
    });

    const highlighted = await highlightReviewFile(file, "dark");

    expect(highlighted.additionLines).toHaveLength(additionLines.length);
    expect(joinTokenContents(highlighted.additionLines)).toEqual(additionLines);
    expect(highlighted.additionLines[205]).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);
    expect(highlighted.additionLines[0]?.some((token) => token.color !== null)).toBe(true);
    expect(joinTokenContents(highlighted.deletionLines)).toEqual(["const removed = true;"]);
  });

  it("returns the same resolved result for concurrent and repeated requests", async () => {
    clearReviewHighlightFileCache();
    const file = makeRenderableFile({
      path: "apps/mobile/src/cache-example.ts",
      additionLines: ["const cached = true;"],
    });

    expect(getCachedHighlightedReviewFile(file, "dark")).toBeNull();

    const [first, second] = await Promise.all([
      highlightReviewFile(file, "dark"),
      highlightReviewFile(file, "dark"),
    ]);
    expect(second).toBe(first);

    const resolvedAgain = await highlightReviewFile(file, "dark");
    expect(resolvedAgain).toBe(first);

    expect(getCachedHighlightedReviewFile(file, "dark")).toBe(first);
    expect(getCachedHighlightedReviewFile(file, "light")).toBeNull();

    clearReviewHighlightFileCache();
    expect(getCachedHighlightedReviewFile(file, "dark")).toBeNull();
  });

  it("evicts the oldest resolved cache entries beyond the cache limit", async () => {
    clearReviewHighlightFileCache();
    const files = Array.from({ length: 9 }, (_, index) =>
      makeRenderableFile({
        path: `apps/mobile/src/evict-${index}.txt`,
        additionLines: [`entry ${index}`],
      }),
    );

    for (const file of files) {
      await highlightReviewFile(file, "light");
    }

    expect(getCachedHighlightedReviewFile(files[0]!, "light")).toBeNull();
    expect(getCachedHighlightedReviewFile(files[1]!, "light")).not.toBeNull();
    expect(getCachedHighlightedReviewFile(files[8]!, "light")).not.toBeNull();
    clearReviewHighlightFileCache();
  });

  it("logs diagnostics when __DEV__ is enabled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    Object.assign(globalThis, { __DEV__: true });
    try {
      clearReviewHighlightFileCache();
      const file = makeRenderableFile({
        path: "apps/mobile/src/dev-logging.txt",
        additionLines: ["logged line"],
      });
      await highlightReviewFile(file, "light");
      await highlightReviewFile(file, "light");

      const messages = logSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes("file highlight start"))).toBe(true);
      expect(
        messages.some((message) => message.includes("file highlight cache hit (resolved)")),
      ).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, "__DEV__");
      logSpy.mockRestore();
      clearReviewHighlightFileCache();
    }
  });
});

describe("streamHighlightReviewFile", () => {
  it("reports a single complete progress event for plain-text files", async () => {
    clearReviewHighlightFileCache();
    const file = makeRenderableFile({
      path: "apps/mobile/src/stream-plain.txt",
      additionLines: ["added text"],
      deletionLines: ["removed text"],
    });
    const events: ReviewHighlightFileProgress[] = [];

    const highlighted = await streamHighlightReviewFile(file, "light", (progress) => {
      events.push(progress);
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.complete).toBe(true);
    expect(events[0]?.highlightedLineCount).toBe(2);
    expect(events[0]?.highlightedFile).toBe(highlighted);
    expect(joinTokenContents(highlighted.additionLines)).toEqual(["added text"]);
    expect(joinTokenContents(highlighted.deletionLines)).toEqual(["removed text"]);
  });

  it("streams chunked syntax highlighting and caches the resolved file", async () => {
    clearReviewHighlightFileCache();
    const longLine = `const wide = "${"y".repeat(1_050)}";`;
    const additionLines = [
      ...Array.from({ length: 205 }, (_, index) => `const streamed${index} = ${index};`),
      longLine,
    ];
    const file = makeRenderableFile({
      path: "apps/mobile/src/stream-chunked.ts",
      additionLines,
      deletionLines: ["const gone = 1;", "const alsoGone = 2;"],
    });
    const events: ReviewHighlightFileProgress[] = [];

    const highlighted = await streamHighlightReviewFile(file, "dark", (progress) => {
      events.push(progress);
    });

    expect(events.at(-1)?.complete).toBe(true);
    expect(events.at(-1)?.highlightedLineCount).toBe(additionLines.length + 2);
    expect(highlighted.additionLines).toHaveLength(additionLines.length);
    expect(joinTokenContents(highlighted.additionLines)).toEqual(additionLines);
    expect(highlighted.additionLines[205]).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);

    const cachedEvents: ReviewHighlightFileProgress[] = [];
    const cached = await streamHighlightReviewFile(file, "dark", (progress) => {
      cachedEvents.push(progress);
    });
    expect(cached).toBe(highlighted);
    expect(cachedEvents).toHaveLength(1);
    expect(cachedEvents[0]?.complete).toBe(true);
    clearReviewHighlightFileCache();
  });

  it("applies word-alt diff emphasis in the streaming plain-text path", async () => {
    clearReviewHighlightFileCache();
    const file = makeRenderableFile({
      path: "apps/mobile/src/stream-word-diff.txt",
      additionLines: ["value two"],
      deletionLines: ["value one"],
      rows: [
        makeLineRow({
          id: "delete-1",
          change: "delete",
          content: "value one",
          deletionTokenIndex: 0,
          comparison: { change: "add", tokenIndex: 0 },
        }),
        makeLineRow({
          id: "add-1",
          change: "add",
          content: "value two",
          additionTokenIndex: 0,
          comparison: { change: "delete", tokenIndex: 0 },
        }),
      ],
    });

    const highlighted = await streamHighlightReviewFile(file, "light", () => {});

    expect(highlighted.additionLines[0]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted.deletionLines[0]?.some((token) => token.diffHighlight === true)).toBe(true);
    clearReviewHighlightFileCache();
  });
});

describe("highlightReviewSelectedLines", () => {
  it("returns an empty token map when no lines are selected", async () => {
    await expect(
      highlightReviewSelectedLines({
        filePath: "apps/mobile/src/empty.ts",
        lines: [],
        theme: "light",
      }),
    ).resolves.toEqual({});
  });

  it("maps highlighted tokens per row id and emphasizes paired word diffs", async () => {
    const lines: ReviewRenderableLineRow[] = [
      makeLineRow({
        id: "context-1",
        change: "context",
        content: "const untouched = 0;",
      }),
      makeLineRow({
        id: "delete-1",
        change: "delete",
        content: "const before = 1;",
        deletionTokenIndex: 0,
        comparison: { change: "add", tokenIndex: 0 },
      }),
      makeLineRow({
        id: "add-1",
        change: "add",
        content: "const after = 2;",
        additionTokenIndex: 0,
        comparison: { change: "delete", tokenIndex: 0 },
      }),
    ];

    const tokenMap = await highlightReviewSelectedLines({
      filePath: "apps/mobile/src/selected.ts",
      lines,
      theme: "light",
    });

    expect(Object.keys(tokenMap).sort()).toEqual(["add-1", "context-1", "delete-1"]);
    expect(tokenMap["context-1"]?.map((token) => token.content).join("")).toBe(
      "const untouched = 0;",
    );
    expect(tokenMap["delete-1"]?.map((token) => token.content).join("")).toBe("const before = 1;");
    expect(tokenMap["add-1"]?.map((token) => token.content).join("")).toBe("const after = 2;");
    expect(tokenMap["delete-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(tokenMap["add-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(tokenMap["context-1"]?.some((token) => token.diffHighlight === true)).toBe(false);
  });

  it("skips word-diff emphasis for unpaired changed lines", async () => {
    const lines: ReviewRenderableLineRow[] = [
      makeLineRow({
        id: "delete-unpaired",
        change: "delete",
        content: "const removed = 1;",
        deletionTokenIndex: 0,
      }),
      makeLineRow({
        id: "add-unpaired",
        change: "add",
        content: "const added = 2;",
        additionTokenIndex: 0,
        comparison: { change: "add", tokenIndex: 5 },
      }),
    ];

    const tokenMap = await highlightReviewSelectedLines({
      filePath: "apps/mobile/src/unpaired.ts",
      lines,
      theme: "dark",
      languageHint: "ts",
    });

    expect(tokenMap["delete-unpaired"]?.some((token) => token.diffHighlight === true)).toBe(false);
    expect(tokenMap["add-unpaired"]?.some((token) => token.diffHighlight === true)).toBe(false);
  });
});

describe("highlightSourceFile", () => {
  it("highlights full file contents using the detected language", async () => {
    const contents = 'fn main() {\n    println!("hello");\n}';
    const highlighted = await highlightSourceFile({
      path: "src/main.rs",
      contents,
      theme: "dark",
    });

    expect(joinTokenContents(highlighted)).toEqual(contents.split("\n"));
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });

  it("returns plain tokens for unknown file types", async () => {
    const highlighted = await highlightSourceFile({
      path: "docs/readme.unknownext",
      contents: "plain body",
      theme: "light",
    });

    expect(joinTokenContents(highlighted)).toEqual(["plain body"]);
  });
});

describe("highlightCodeSnippet", () => {
  it("resolves language aliases and returns syntax-colored tokens", async () => {
    const source = "const answer: number = 42;";
    const highlighted = await highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });

  it("returns no lines for empty snippets", async () => {
    await expect(
      highlightCodeSnippet({ code: "", language: "ts", theme: "light" }),
    ).resolves.toEqual([]);
  });

  it("falls back to plain text for blank, unknown, and ansi language hints", async () => {
    const blank = await highlightCodeSnippet({
      code: "some text",
      language: "   ",
      theme: "light",
    });
    expect(joinTokenContents(blank)).toEqual(["some text"]);

    const unknown = await highlightCodeSnippet({
      code: "@@weird",
      language: "brainfuck",
      theme: "light",
    });
    expect(joinTokenContents(unknown)).toEqual(["@@weird"]);

    const ansi = await highlightCodeSnippet({ code: "colored", language: "ansi", theme: "dark" });
    expect(joinTokenContents(ansi)).toEqual(["colored"]);

    const missing = await highlightCodeSnippet({ code: "no hint", theme: "dark" });
    expect(joinTokenContents(missing)).toEqual(["no hint"]);
  });

  it("tokenizes long snippet lines as single plain tokens", async () => {
    const longLine = `const long = "${"q".repeat(1_050)}";`;
    const source = ["const first = 1;", longLine, "const last = 2;"].join("\n");

    const highlighted = await highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "light",
    });

    expect(joinTokenContents(highlighted)).toEqual(source.split("\n"));
    expect(highlighted[1]).toEqual([{ content: longLine, color: null, fontStyle: null }]);
  });
});

describe("prepareReviewHighlighter", () => {
  it("initializes the highlighter and reports the javascript engine under test", async () => {
    await prepareReviewHighlighter();
    await expect(getActiveReviewHighlighterEngine()).resolves.toBe("javascript");
  });

  it("loads dynamic language grammars, ignoring unknown languages and text", async () => {
    await prepareReviewHighlighterLanguages([
      "python",
      "rust",
      "go",
      "java",
      "kotlin",
      "swift",
      "objc",
      "c",
      "cpp",
      "cs",
      "php",
      "rb",
      "lua",
      "perl",
      "r",
      "dart",
      "scala",
      "ex",
      "hs",
      "clj",
      "ml",
      "fs",
      "erl",
      "zig",
      "nim",
      "html",
      "css",
      "scss",
      "less",
      "xml",
      "svg",
      "vue",
      "svelte",
      "astro",
      "jsonc",
      "toml",
      "ini",
      "shell",
      "ps1",
      "fish",
      "sql",
      "graphql",
      "prisma",
      "dockerfile",
      "tf",
      "nix",
      "md",
      "mdx",
      "tex",
      "diff",
      "regex",
      "vim",
      "make",
      "cmake",
      "text",
      "not-a-real-language",
    ]);

    const highlighted = await highlightCodeSnippet({
      code: "def add(a, b):\n    return a + b",
      language: "PY",
      theme: "light",
    });
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });

  it("deduplicates concurrent loads of the same language", async () => {
    await Promise.all([
      prepareReviewHighlighterLanguages(["groovy"]),
      prepareReviewHighlighterLanguages(["groovy"]),
    ]);

    const highlighted = await highlightCodeSnippet({
      code: 'println "groovy"',
      language: "groovy",
      theme: "dark",
    });
    expect(joinTokenContents(highlighted)).toEqual(['println "groovy"']);
  });
});

describe("ReviewHighlighterEngineInitializationError", () => {
  it("describes the attempted and preferred engines in its message", () => {
    const error = new ReviewHighlighterEngineInitializationError({
      preferredEngine: "native",
      attemptedEngine: "javascript",
      cause: new Error("boom"),
    });

    expect(error.message).toBe(
      "Failed to initialize the javascript review highlighter with native preferred.",
    );
    expect(error.preferredEngine).toBe("native");
    expect(error.attemptedEngine).toBe("javascript");
  });
});

describe("engine initialization", () => {
  afterEach(() => {
    vi.doUnmock("react-native-shiki-engine");
    vi.unstubAllEnvs();
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "__DEV__");
    vi.restoreAllMocks();
  });

  it("uses the native engine when preferred and available", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.assign(globalThis, { __DEV__: true });
    vi.stubEnv("EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE", "native");
    vi.doMock("react-native-shiki-engine", () => ({
      isNativeEngineAvailable: () => true,
      createNativeEngine: () => createJavaScriptRegexEngine(),
    }));
    vi.resetModules();

    const fresh: typeof import("./shikiReviewHighlighter") =
      await import("./shikiReviewHighlighter");

    await expect(fresh.getActiveReviewHighlighterEngine()).resolves.toBe("native");
  });

  it("falls back to the javascript engine when the native engine is unavailable", async () => {
    vi.stubEnv("EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE", "native");
    vi.doMock("react-native-shiki-engine", () => ({
      isNativeEngineAvailable: () => false,
      createNativeEngine: () => {
        throw new Error("should not be called");
      },
    }));
    vi.resetModules();

    const fresh: typeof import("./shikiReviewHighlighter") =
      await import("./shikiReviewHighlighter");

    await expect(fresh.getActiveReviewHighlighterEngine()).resolves.toBe("javascript");
  });

  it("falls back to the javascript engine when the native module fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(globalThis, { __DEV__: true });
    vi.stubEnv("EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE", "native");
    vi.doMock("react-native-shiki-engine", () => {
      throw new Error("native module unavailable");
    });
    vi.resetModules();

    const fresh: typeof import("./shikiReviewHighlighter") =
      await import("./shikiReviewHighlighter");

    await expect(fresh.getActiveReviewHighlighterEngine()).resolves.toBe("javascript");
  });
});
