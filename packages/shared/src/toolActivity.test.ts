import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("uses command sources in lifecycle precedence order", () => {
    const baseData = {
      item: {
        command: "item command",
        input: { command: "item input command" },
        result: { command: "item result command" },
      },
      command: "data command",
      rawInput: { command: "raw command" },
    };

    expect(
      deriveToolActivityPresentation({ itemType: "command_execution", data: baseData }),
    ).toEqual({ summary: "Ran command", detail: "item command" });
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        data: { ...baseData, item: { ...baseData.item, command: [] } },
      }),
    ).toEqual({ summary: "Ran command", detail: "item input command" });
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        data: {
          ...baseData,
          item: { command: null, input: { command: null }, result: baseData.item.result },
        },
      }),
    ).toEqual({ summary: "Ran command", detail: "item result command" });
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        data: { ...baseData, item: { input: [], result: [] } },
      }),
    ).toEqual({ summary: "Ran command", detail: "data command" });
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        data: { item: [], command: [], rawInput: { command: "raw command" } },
      }),
    ).toEqual({ summary: "Ran command", detail: "raw command" });
  });

  it("composes executable arguments and falls back to command titles", () => {
    expect(
      deriveToolActivityPresentation({
        data: { kind: "execute", rawInput: { executable: "git", args: ["status", " ", 3] } },
      }),
    ).toEqual({ summary: "Ran command", detail: "git status" });
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        data: { rawInput: { executable: "pwd", args: [] } },
      }),
    ).toEqual({ summary: "Ran command", detail: "pwd" });
    expect(
      deriveToolActivityPresentation({ itemType: "command_execution", title: "Run `vp check`" }),
    ).toEqual({ summary: "Ran command", detail: "vp check" });
    expect(
      deriveToolActivityPresentation({ itemType: "command_execution", title: "Run command" }),
    ).toEqual({ summary: "Ran command" });
  });

  it("recognizes every command, read, file-change, and search action signal", () => {
    for (const input of [{ data: { kind: "execute" } }, { title: "Terminal" }]) {
      expect(deriveToolActivityPresentation(input)).toEqual({ summary: "Ran command" });
    }

    for (const input of [{ data: { kind: "read" } }, { title: "Read File" }]) {
      expect(deriveToolActivityPresentation(input)).toEqual({ summary: "Read file" });
    }

    for (const input of [
      { itemType: "file_change" as const },
      { data: { kind: "edit" } },
      { data: { kind: "move" } },
      { data: { kind: "delete" } },
      { data: { kind: "write" } },
    ]) {
      expect(deriveToolActivityPresentation(input)).toEqual({ summary: "Changed files" });
    }

    for (const input of [
      { itemType: "web_search" as const },
      { data: { kind: "search" } },
      { title: "Find" },
      { title: "Grep" },
    ]) {
      expect(deriveToolActivityPresentation(input)).toEqual({ summary: "Searched files" });
    }
  });

  it("uses every search query fallback and omits malformed queries", () => {
    for (const [rawInput, detail] of [
      [{ query: "alpha", pattern: "beta", searchTerm: "gamma" }, "alpha"],
      [{ query: " ", pattern: "beta", searchTerm: "gamma" }, "beta"],
      [{ pattern: 1, searchTerm: "gamma" }, "gamma"],
    ] as const) {
      expect(deriveToolActivityPresentation({ data: { kind: "search", rawInput } })).toEqual({
        summary: "Searched files",
        detail,
      });
    }

    expect(
      deriveToolActivityPresentation({ data: { kind: "search", rawInput: "malformed" } }),
    ).toEqual({ summary: "Searched files" });
  });

  it("extracts supported path keys and nested locations", () => {
    for (const [key, path] of [
      ["path", "/repo/a.ts"],
      ["filePath", "src\\b.ts"],
      ["relativePath", "./c"],
      ["filename", "d.json"],
      ["newPath", "folder/e"],
      ["oldPath", "f.rs"],
    ] as const) {
      expect(deriveToolActivityPresentation({ data: { kind: "read", [key]: path } })).toEqual({
        summary: "Read file",
        detail: path,
      });
    }

    for (const nestedKey of [
      "locations",
      "item",
      "input",
      "result",
      "rawInput",
      "data",
      "changes",
    ]) {
      expect(
        deriveToolActivityPresentation({
          itemType: "file_change",
          data: { [nestedKey]: [{ path: "/nested/file.ts" }] },
        }),
      ).toEqual({ summary: "Changed files", detail: "/nested/file.ts" });
    }
  });

  it("deduplicates and bounds recursive path extraction", () => {
    const eightPaths = Array.from({ length: 8 }, (_, index) => ({ path: `/p/${index}.ts` }));
    const ignored = Object.defineProperty({}, "path", {
      get: () => {
        throw new Error("path traversal exceeded its limit");
      },
    });

    expect(
      deriveToolActivityPresentation({
        data: {
          kind: "read",
          path: "/first.ts",
          filePath: "/first.ts",
          locations: [...eightPaths, ignored],
        },
      }),
    ).toEqual({ summary: "Read file", detail: "/first.ts" });
    expect(
      deriveToolActivityPresentation({
        data: {
          kind: "read",
          item: { input: { result: { data: { changes: { path: "/too-deep.ts" } } } } },
        },
      }),
    ).toEqual({ summary: "Read file" });
  });

  it("rejects non-path strings and malformed path containers", () => {
    expect(
      deriveToolActivityPresentation({
        data: { kind: "read", path: "README", locations: [null, 1, "src/file.ts"] },
      }),
    ).toEqual({ summary: "Read file" });
  });

  it("strips exit markers and suppresses equivalent generic details", () => {
    expect(
      deriveToolActivityPresentation({
        title: "Custom Tool",
        detail: "useful output\n<exited with exit code 17>",
      }),
    ).toEqual({ summary: "Custom Tool", detail: "useful output" });
    expect(
      deriveToolActivityPresentation({ title: "Custom Tool", detail: "<exited with exit code 0>" }),
    ).toEqual({ summary: "Custom Tool" });
    expect(
      deriveToolActivityPresentation({ title: "Deploy", detail: " deploy completed " }),
    ).toEqual({
      summary: "Deploy",
    });
    expect(
      deriveToolActivityPresentation({
        detail: " fallback   started ",
        fallbackSummary: "Fallback",
      }),
    ).toEqual({ summary: "Fallback" });
  });

  it("uses stable fallbacks for unknown and malformed activity", () => {
    expect(
      deriveToolActivityPresentation({
        title: "Custom Tool",
        detail: "specific detail",
        data: { kind: "unknown" },
      }),
    ).toEqual({ summary: "Custom Tool", detail: "specific detail" });
    expect(
      deriveToolActivityPresentation({ title: " ", fallbackSummary: "Fallback", data: [] }),
    ).toEqual({ summary: "Fallback" });
    expect(
      deriveToolActivityPresentation({ detail: "specific detail", fallbackSummary: "Fallback" }),
    ).toEqual({ summary: "Fallback", detail: "specific detail" });
    expect(deriveToolActivityPresentation({ data: null })).toEqual({ summary: "Tool" });
  });
});
