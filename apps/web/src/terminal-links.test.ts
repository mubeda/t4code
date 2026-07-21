import { describe, expect, it } from "vite-plus/test";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  splitPathAndPosition,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
  type TerminalBufferLineLike,
} from "./terminal-links";

function createBufferLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.replace(/\s+$/u, "") : text),
  };
}

describe("extractTerminalLinks", () => {
  it("finds http urls and path tokens", () => {
    const line =
      "failed at https://example.com/docs and src/components/ThreadTerminalDrawer.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalDrawer.tsx:42",
        start: 39,
        end: 81,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });

  it("finds Windows absolute paths with forward slashes", () => {
    const line = "see C:/Users/someone/project/src/file.ts:42 for details";
    const path = "C:/Users/someone/project/src/file.ts:42";
    const start = line.indexOf(path);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: path,
        start,
        end: start + path.length,
      },
    ]);
  });

  it("trims trailing punctuation from Windows forward-slash paths", () => {
    const line = "(C:/tmp/x.ts).";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: "C:/tmp/x.ts",
        start: 1,
        end: 12,
      },
    ]);
  });

  it("trims only unbalanced closing delimiters and keeps balanced ones", () => {
    expect(extractTerminalLinks("(https://example.test/a(b)) [./a[b].ts] {./a{b}.ts}")).toEqual([
      expect.objectContaining({ kind: "url", text: "https://example.test/a(b)" }),
      expect.objectContaining({ kind: "path", text: "./a[b].ts" }),
      expect.objectContaining({ kind: "path", text: "./a{b}.ts" }),
    ]);
    expect(extractTerminalLinks("...,,,!!!")).toEqual([]);
  });
});

describe("collectWrappedTerminalLinkLine", () => {
  it("reconstructs a wrapped line from any physical row", () => {
    const firstSegment = "see https://example.com/a";
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
      createBufferLine("done"),
    ];

    const fromFirstRow = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    const fromWrappedRow = collectWrappedTerminalLinkLine(3, (index) => lines[index]);

    expect(fromFirstRow).toEqual({
      text: `${firstSegment}${secondSegment}`,
      segments: [
        {
          bufferLineNumber: 2,
          text: firstSegment,
          startIndex: 0,
          endIndex: firstSegment.length,
        },
        {
          bufferLineNumber: 3,
          text: secondSegment,
          startIndex: firstSegment.length,
          endIndex: firstSegment.length + secondSegment.length,
        },
      ],
    });
    expect(fromWrappedRow).toEqual(fromFirstRow);
  });

  it("preserves trailing spaces on continued segments for downstream offsets", () => {
    const firstSegment = "prefix   ";
    const secondSegment = "https://example.com/path";
    const lines = [createBufferLine(firstSegment), createBufferLine(secondSegment, true)];

    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine?.text).toBe(`${firstSegment}${secondSegment}`);
    expect(extractTerminalLinks(wrappedLine?.text ?? "")).toEqual([
      {
        kind: "url",
        text: secondSegment,
        start: firstSegment.length,
        end: firstSegment.length + secondSegment.length,
      },
    ]);
  });

  it("returns null for missing anchors or broken wrapped predecessors", () => {
    expect(collectWrappedTerminalLinkLine(1, () => undefined)).toBeNull();
    const lines = [undefined, createBufferLine("continued", true)];
    expect(collectWrappedTerminalLinkLine(2, (index) => lines[index])).toBeNull();
  });

  it("stops at the first missing continuation line", () => {
    const lines = [createBufferLine("first"), undefined, createBufferLine("later", true)];
    expect(collectWrappedTerminalLinkLine(1, (index) => lines[index])).toEqual({
      text: "first",
      segments: [{ bufferLineNumber: 1, text: "first", startIndex: 0, endIndex: 5 }],
    });
  });

  it("bounds the window on enormous wrapped logical lines and keeps the hovered row inside", () => {
    // ConPTY can mark an entire alt-screen TUI frame as one wrapped logical
    // line; an unbounded hover-time walk previously assembled the whole
    // scrollback per mouse event and exhausted the renderer heap.
    const totalRows = 10_000;
    const hoveredBufferLineNumber = 5_000;
    const getLine = (index: number) => {
      if (index < 0 || index >= totalRows) return undefined;
      const text =
        index === hoveredBufferLineNumber - 1 ? " https://example.com/hit " : `row ${index} `;
      return createBufferLine(text, index > 0);
    };

    const wrappedLine = collectWrappedTerminalLinkLine(hoveredBufferLineNumber, getLine);

    expect(wrappedLine).not.toBeNull();
    expect(wrappedLine!.segments.length).toBeLessThanOrEqual(100);
    const rowNumbers = wrappedLine!.segments.map((segment) => segment.bufferLineNumber);
    expect(rowNumbers).toContain(hoveredBufferLineNumber);
    expect(Math.min(...rowNumbers)).toBeGreaterThanOrEqual(hoveredBufferLineNumber - 50);
    expect(wrappedLine!.text).toContain("https://example.com/hit");
  });

  it("trims very long unbalanced delimiter tails without quadratic blowup", () => {
    const line = `see https://example.com/a${")".repeat(50_000)} end`;
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/a",
        start: 4,
        end: 25,
      },
    ]);
  });
});

describe("resolveWrappedTerminalLinkRange", () => {
  it("maps wrapped URL matches back to the correct buffer rows", () => {
    const prefix = "see ";
    const firstSegment = `${prefix}https://example.com/a`;
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
    ];
    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine).not.toBeNull();
    if (!wrappedLine) {
      throw new Error("Expected wrapped terminal line to be present.");
    }

    const [match] = extractTerminalLinks(wrappedLine.text);
    expect(match).toEqual({
      kind: "url",
      text: "https://example.com/a/bc?x=1",
      start: prefix.length,
      end: firstSegment.length + secondSegment.length,
    });
    if (!match) {
      throw new Error("Expected wrapped URL match to be present.");
    }

    const range = resolveWrappedTerminalLinkRange(wrappedLine, match);

    expect(range).toEqual({
      start: { x: prefix.length + 1, y: 2 },
      end: { x: secondSegment.length, y: 3 },
    });
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 2)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 3)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 4)).toBe(false);
  });

  it("clamps character positions beyond the final or an empty segment list", () => {
    expect(
      resolveWrappedTerminalLinkRange(
        {
          text: "abc",
          segments: [{ bufferLineNumber: 7, text: "abc", startIndex: 0, endIndex: 3 }],
        },
        { start: 9, end: 11 },
      ),
    ).toEqual({ start: { x: 3, y: 7 }, end: { x: 3, y: 7 } });
    expect(
      resolveWrappedTerminalLinkRange({ text: "", segments: [] }, { start: 0, end: 1 }),
    ).toEqual({ start: { x: 1, y: 1 }, end: { x: 1, y: 1 } });
  });
});

describe("resolvePathLinkTarget", () => {
  it("splits absent, line-only, and line-column suffixes", () => {
    expect(splitPathAndPosition("src/a.ts")).toEqual({
      path: "src/a.ts",
      line: undefined,
      column: undefined,
    });
    expect(splitPathAndPosition("src/a.ts:4")).toEqual({
      path: "src/a.ts",
      line: "4",
      column: undefined,
    });
    expect(splitPathAndPosition("src/a.ts:4:2")).toEqual({
      path: "src/a.ts",
      line: "4",
      column: "2",
    });
  });

  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  it("expands home paths for macOS, Linux, and Windows cwd styles", () => {
    expect(resolvePathLinkTarget("~/src/a.ts", "/Users/alice/project")).toBe(
      "/Users/alice/src/a.ts",
    );
    expect(resolvePathLinkTarget("~/src/a.ts:2", "/home/alice/project")).toBe(
      "/home/alice/src/a.ts:2",
    );
    expect(resolvePathLinkTarget("~/src/a.ts", "C:\\Users\\alice\\project")).toBe(
      "C:\\Users\\alice\\src\\a.ts",
    );
    expect(resolvePathLinkTarget("~/src/a.ts", "/opt/project")).toBe("~/src/a.ts");
  });

  it("joins relative Windows paths and trims existing cwd separators", () => {
    expect(resolvePathLinkTarget("src/a.ts", "C:\\repo\\")).toBe("C:\\repo\\src\\a.ts");
    expect(resolvePathLinkTarget("/absolute/a.ts", "/repo///")).toBe("/absolute/a.ts");
  });
});

describe("isTerminalLinkActivation", () => {
  it("requires cmd on macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("requires ctrl on non-macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "Linux",
      ),
    ).toBe(false);
  });

  it("rejects unknown platforms and conflicting modifier keys", () => {
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false }, "")).toBe(false);
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: true }, "Linux")).toBe(false);
  });
});
