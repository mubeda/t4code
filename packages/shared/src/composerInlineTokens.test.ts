import { describe, expect, it } from "vite-plus/test";

import { collectComposerInlineTokens } from "./composerInlineTokens.ts";
import { canonicalizeLegacyComposerFileReferences } from "./composerReferences.ts";

describe("collectComposerInlineTokens", () => {
  it("collects file links, mentions, and skills with source ranges", () => {
    const text = "Use $ui and inspect [Chat.tsx](src/Chat.tsx) with @AGENTS.md please";

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "skill",
        value: "ui",
        source: "$ui",
        start: 4,
        end: 7,
      },
      {
        type: "mention",
        value: "src/Chat.tsx",
        source: "[Chat.tsx](src/Chat.tsx)",
        start: 20,
        end: 44,
      },
      {
        type: "mention",
        value: "AGENTS.md",
        source: "@AGENTS.md",
        start: 50,
        end: 60,
      },
    ]);
  });

  it("does not convert incomplete trailing tokens", () => {
    expect(collectComposerInlineTokens("Use $ui")).toEqual([]);
    expect(collectComposerInlineTokens("Inspect @AGENTS.md")).toEqual([]);
  });

  it("keeps the delimiter after a token outside its source range", () => {
    const text = "Inspect [package.json](package.json) next";

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "mention",
        value: "package.json",
        source: "[package.json](package.json)",
        start: 8,
        end: 36,
      },
    ]);
    expect(text.slice(36)).toBe(" next");
  });

  it("preserves a confirmed pill when only its trailing delimiter is removed", () => {
    const withDelimiter = "[package.json](package.json) ";
    const confirmed = collectComposerInlineTokens(withDelimiter);

    expect(
      collectComposerInlineTokens(withDelimiter.trimEnd(), { preserveTrailingFrom: confirmed }),
    ).toEqual([
      {
        type: "mention",
        value: "package.json",
        source: "[package.json](package.json)",
        start: 0,
        end: 28,
      },
    ]);
  });

  it("does not preserve a pill after its source is edited", () => {
    const confirmed = collectComposerInlineTokens("[package.json](package.json) ");

    expect(
      collectComposerInlineTokens("[package.json](package-json)", {
        preserveTrailingFrom: confirmed,
      }),
    ).toEqual([]);
  });

  it("ignores normal web links", () => {
    expect(collectComposerInlineTokens("Read [docs](https://example.com) first")).toEqual([]);
  });

  it("decodes file-link paths and escaped labels", () => {
    const tokens = collectComposerInlineTokens(
      "Open [hello world.ts](src/hello%20world.ts) and [a\\]b.ts](src/a%5Db.ts) now",
    );
    expect(tokens.map(({ value, source, start, end }) => ({ value, source, start, end }))).toEqual([
      {
        value: "src/hello world.ts",
        source: "[hello world.ts](src/hello%20world.ts)",
        start: 5,
        end: 43,
      },
      {
        value: "src/a]b.ts",
        source: "[a\\]b.ts](src/a%5Db.ts)",
        start: 48,
        end: 71,
      },
    ]);
  });

  it("preserves malformed URI escapes when the authored basename still matches", () => {
    expect(collectComposerInlineTokens("Open [bad%ZZ](bad%ZZ) now")[0]).toEqual({
      type: "mention",
      value: "bad%ZZ",
      source: "[bad%ZZ](bad%ZZ)",
      start: 5,
      end: 21,
    });
  });

  it("accepts Windows file links while rejecting schemes and mismatched labels", () => {
    expect(collectComposerInlineTokens("Open [file.ts](C:\\repo\\file.ts) now")[0]?.value).toBe(
      "C:\\repo\\file.ts",
    );
    expect(collectComposerInlineTokens("Email [person](mailto:user@example.com) now")).toEqual([]);
    expect(collectComposerInlineTokens("Open [other.ts](src/file.ts) now")).toEqual([]);
    expect(collectComposerInlineTokens("Open [](src/file.ts) now")).toEqual([]);
  });

  it("parses quoted and escaped mentions and rejects an empty quoted mention", () => {
    const text = 'Open @"folder\\"quoted\\" file.ts" then @plain.ts now';
    expect(collectComposerInlineTokens(text).map((token) => token.value)).toEqual([
      'folder"quoted" file.ts',
      "plain.ts",
    ]);
    expect(collectComposerInlineTokens('Open @"" now')).toEqual([]);
  });

  it("keeps native and agent-shaped references lossless while migrating only file links", () => {
    const text = 'Open @src/main.ts @"docs/My File.md" @agent:reviewer now';

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "mention",
        value: "src/main.ts",
        source: "@src/main.ts",
        start: 5,
        end: 17,
      },
      {
        type: "mention",
        value: "docs/My File.md",
        source: '@"docs/My File.md"',
        start: 18,
        end: 36,
      },
      {
        type: "mention",
        value: "agent:reviewer",
        source: "@agent:reviewer",
        start: 37,
        end: 52,
      },
    ]);
    expect(canonicalizeLegacyComposerFileReferences(text)).toBe(text);
    expect(canonicalizeLegacyComposerFileReferences("Open [main.ts](src/main.ts) now")).toBe(
      "Open @src/main.ts now",
    );
  });

  it("accepts namespaced skills and sorts mixed tokens by source offset", () => {
    const text = "Use @later.ts then $provider:skill-name now";
    expect(
      collectComposerInlineTokens(text).map(({ type, value, start }) => ({ type, value, start })),
    ).toEqual([
      { type: "mention", value: "later.ts", start: 4 },
      { type: "skill", value: "provider:skill-name", start: 19 },
    ]);
    expect(collectComposerInlineTokens("Use $9invalid now")).toEqual([]);
  });

  it("accepts one preserved trailing token and suppresses identical duplicates", () => {
    const token = {
      type: "mention" as const,
      value: "package.json",
      source: "@package.json",
      start: 0,
      end: 13,
    };
    expect(
      collectComposerInlineTokens("@package.json", { preserveTrailingFrom: [token, token] }),
    ).toEqual([token]);
  });

  it("rejects preserved tokens with stale ranges and accepts distinct valid ranges", () => {
    const text = "aaaa";
    const full = { type: "mention" as const, value: "aaaa", source: "aaaa", start: 0, end: 4 };
    const suffix = { type: "mention" as const, value: "aaa", source: "aaa", start: 1, end: 4 };
    const wrongEnd = { ...full, end: 3 };
    const wrongSource = { ...full, source: "bbbb" };
    expect(
      collectComposerInlineTokens(text, {
        preserveTrailingFrom: [wrongEnd, wrongSource, full, suffix],
      }),
    ).toEqual([full, suffix]);
  });

  it("distinguishes a preserved full source from a parsed token with a shorter range", () => {
    const text = "@a ";
    const preserved = {
      type: "mention" as const,
      value: "a",
      source: text,
      start: 0,
      end: text.length,
    };
    expect(collectComposerInlineTokens(text, { preserveTrailingFrom: [preserved] })).toEqual([
      { type: "mention", value: "a", source: "@a", start: 0, end: 2 },
      preserved,
    ]);
  });
});
