import { describe, expect, it } from "vite-plus/test";

import {
  canonicalizeLegacyComposerFileReferences,
  serializeComposerReference,
} from "./composerReferences.ts";

describe("serializeComposerReference", () => {
  it("serializes simple and quoted native references", () => {
    expect(serializeComposerReference("src/main.ts")).toBe("@src/main.ts");
    expect(serializeComposerReference("docs/My File.md")).toBe('@"docs/My File.md"');
    expect(serializeComposerReference('docs/My "File".md')).toBe('@"docs/My \\"File\\".md"');
  });

  it("escapes Windows paths", () => {
    expect(serializeComposerReference("C:\\repo\\src\\main.ts")).toBe(
      '@"C:\\\\repo\\\\src\\\\main.ts"',
    );
  });
});

describe("canonicalizeLegacyComposerFileReferences", () => {
  it("migrates only recognized legacy file links", () => {
    expect(
      canonicalizeLegacyComposerFileReferences(
        "Inspect [main.ts](src/main.ts) and [docs](https://example.com) next",
      ),
    ).toBe("Inspect @src/main.ts and [docs](https://example.com) next");
  });

  it("migrates recognized file links in mixed content", () => {
    expect(
      canonicalizeLegacyComposerFileReferences(
        "Use @existing.ts and [My File.md](docs/My%20File.md) with $review now",
      ),
    ).toBe('Use @existing.ts and @"docs/My File.md" with $review now');
  });

  it("leaves malformed and external Markdown links untouched", () => {
    expect(
      canonicalizeLegacyComposerFileReferences(
        "Keep [other.ts](src/file.ts), [broken](src/broken.ts, and [web](mailto:a@example.com) now",
      ),
    ).toBe(
      "Keep [other.ts](src/file.ts), [broken](src/broken.ts, and [web](mailto:a@example.com) now",
    );
  });
});
