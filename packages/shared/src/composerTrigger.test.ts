import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath compatibility re-export", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs\\My "File".md')).toBe('"docs\\\\My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });

  it("escapes markdown labels and every reserved destination character", () => {
    expect(serializeComposerFileLink("folder\\a[b]#c?.txt")).toBe(
      "[a\\[b\\]#c?.txt](folder%5Ca%5Bb%5D%23c%3F.txt)",
    );
  });

  it("uses the whole path as the label when it has no separator", () => {
    expect(serializeComposerFileLink("README.md")).toBe("[README.md](README.md)");
  });
});

describe("detectComposerTrigger", () => {
  it("detects slash commands and the model picker at the start of a line", () => {
    expect(detectComposerTrigger("/help", 5)).toEqual({
      kind: "slash-command",
      query: "help",
      rangeStart: 0,
      rangeEnd: 5,
    });
    expect(detectComposerTrigger("prefix\n/model", 13)).toEqual({
      kind: "slash-model",
      query: "",
      rangeStart: 7,
      rangeEnd: 13,
    });
    expect(detectComposerTrigger("/model   gpt-5 ", 16)).toEqual({
      kind: "slash-model",
      query: "gpt-5",
      rangeStart: 0,
      rangeEnd: 15,
    });
    expect(detectComposerTrigger("/model", 6)).toEqual({
      kind: "slash-model",
      query: "",
      rangeStart: 0,
      rangeEnd: 6,
    });
    expect(detectComposerTrigger("/MODEL", 6)).toEqual({
      kind: "slash-command",
      query: "MODEL",
      rangeStart: 0,
      rangeEnd: 6,
    });
    expect(detectComposerTrigger("/MODEL gpt-5", 12)).toBeNull();
  });

  it("falls back to token detection when a slash expression is not a command", () => {
    expect(detectComposerTrigger("/help argument", 14)).toBeNull();
  });

  it("detects path and skill tokens after each supported whitespace boundary", () => {
    expect(detectComposerTrigger("open @src/app", 13)).toEqual({
      kind: "path",
      query: "src/app",
      rangeStart: 5,
      rangeEnd: 13,
    });
    expect(detectComposerTrigger("use\t$review", 11)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: 11,
    });
    expect(detectComposerTrigger("use\r@file", 9)?.query).toBe("file");
    expect(detectComposerTrigger("use\n$", 5)?.query).toBe("");
  });

  it("supports caller-defined token boundaries", () => {
    expect(detectComposerTrigger("context\u0000@src", 12, (char) => char === "\u0000")).toEqual({
      kind: "path",
      query: "src",
      rangeStart: 8,
      rangeEnd: 12,
    });
  });

  it("clamps invalid and out-of-range cursor positions", () => {
    expect(detectComposerTrigger("@file", Number.NaN)?.rangeEnd).toBe(5);
    expect(detectComposerTrigger("@file", Number.POSITIVE_INFINITY)?.rangeEnd).toBe(5);
    expect(detectComposerTrigger("@file", 99)?.rangeEnd).toBe(5);
    expect(detectComposerTrigger("@file", 3.9)).toEqual({
      kind: "path",
      query: "fi",
      rangeStart: 0,
      rangeEnd: 3,
    });
    expect(detectComposerTrigger("@file", -2)).toBeNull();
  });

  it("returns null for ordinary and empty tokens", () => {
    expect(detectComposerTrigger("ordinary", 8)).toBeNull();
    expect(detectComposerTrigger("", 0)).toBeNull();
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone plan and default commands case-insensitively", () => {
    expect(parseStandaloneComposerSlashCommand("  /PLAN  ")).toBe("plan");
    expect(parseStandaloneComposerSlashCommand("/Default\n")).toBe("default");
  });

  it("rejects model, arguments, and unrelated text", () => {
    expect(parseStandaloneComposerSlashCommand("/model")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/plan now")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("plan")).toBeNull();
  });
});

describe("replaceTextRange", () => {
  it("replaces a bounded range and reports the next cursor", () => {
    expect(replaceTextRange("hello world", 6, 11, "there")).toEqual({
      text: "hello there",
      cursor: 11,
    });
  });

  it("clamps reversed and out-of-range boundaries", () => {
    expect(replaceTextRange("abc", -10, -1, "x")).toEqual({ text: "xabc", cursor: 1 });
    expect(replaceTextRange("abc", 2, 1, "x")).toEqual({ text: "abxc", cursor: 3 });
    expect(replaceTextRange("abc", 20, 30, "x")).toEqual({ text: "abcx", cursor: 4 });
  });
});
