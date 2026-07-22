import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FilesystemBrowseError,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
} from "./filesystem.ts";

const decodeFilesystemBrowseError = Schema.decodeUnknownSync(FilesystemBrowseError);
const decodeBrowseInput = Schema.decodeUnknownSync(FilesystemBrowseInput);
const decodeBrowseResult = Schema.decodeUnknownSync(FilesystemBrowseResult);

describe("FilesystemBrowse", () => {
  it("decodes directory navigation without changing legacy autocomplete", () => {
    expect(decodeBrowseInput({ partialPath: "~/src" }).mode).toBeUndefined();
    expect(decodeBrowseInput({ partialPath: "~/src", mode: "directory" }).mode).toBe("directory");
    expect(
      decodeBrowseResult({
        parentPath: "/home/me/src",
        directoryPath: "/home/me/src",
        ancestorPath: "/home/me",
        breadcrumbs: [
          { name: "/", fullPath: "/" },
          { name: "home", fullPath: "/home" },
          { name: "me", fullPath: "/home/me" },
          { name: "src", fullPath: "/home/me/src" },
        ],
        entries: [{ name: "project", fullPath: "/home/me/src/project" }],
      }).directoryPath,
    ).toBe("/home/me/src");
  });
});

describe("FilesystemBrowseError", () => {
  it("derives a stable message from browse context while retaining the cause", () => {
    const cause = new Error("sensitive filesystem detail");
    const error = new FilesystemBrowseError({
      cwd: "/workspace",
      partialPath: "./src/mai",
      failure: "read_directory_failed",
      parentPath: "/workspace/src",
      cause,
    });

    expect(error.message).toBe("Failed to browse filesystem path './src/mai' from '/workspace'.");
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const error = decodeFilesystemBrowseError({
      _tag: "FilesystemBrowseError",
      message: "Legacy filesystem browse failure.",
    });

    expect(error.message).toBe("Legacy filesystem browse failure.");
    expect(error.partialPath).toBeUndefined();
    expect(error.failure).toBeUndefined();
  });

  it("ignores a malformed decoded message override", () => {
    const props = Object.assign(
      {
        partialPath: "./src",
        failure: "read_directory_failed" as const,
      },
      { message: 404 },
    ) as ConstructorParameters<typeof FilesystemBrowseError>[0];
    const error = new FilesystemBrowseError(props);

    expect(error.message).toBe("Failed to browse filesystem path './src'.");
  });
});
