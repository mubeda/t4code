import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  EDITORS,
  EditorId,
  isExternalLauncherError,
  LaunchEditorInput,
} from "./editor.ts";
import {
  expectDecodeFailure,
  expectEncodeFailure,
  makeInvalidClassInstance,
} from "./test/schemaAssertions.ts";

const decodeLaunchEditorInput = Schema.decodeUnknownSync(LaunchEditorInput);
const encodeLaunchEditorInput = Schema.encodeSync(LaunchEditorInput);
const decodeExternalLauncherError = Schema.decodeUnknownSync(ExternalLauncherError);
const encodeExternalLauncherError = Schema.encodeUnknownSync(ExternalLauncherError);
const decodeEditorId = Schema.decodeUnknownSync(EditorId);

const EXPECTED_EDITOR_IDS = [
  "cursor",
  "trae",
  "kiro",
  "vscode",
  "vscode-insiders",
  "vscodium",
  "zed",
  "antigravity",
  "idea",
  "aqua",
  "clion",
  "datagrip",
  "dataspell",
  "goland",
  "phpstorm",
  "pycharm",
  "rider",
  "rubymine",
  "rustrover",
  "webstorm",
  "file-manager",
] as const;

describe("editor schemas", () => {
  it("anchors every supported EditorId to the expected literal catalog", () => {
    expect(EDITORS.map(({ id }) => id)).toEqual(EXPECTED_EDITOR_IDS);
    expect(EXPECTED_EDITOR_IDS.map((id) => decodeEditorId(id))).toEqual(EXPECTED_EDITOR_IDS);
  });

  it("decodes and encodes supported editor launch input", () => {
    const input = { cwd: "/repo", editor: "vscode" } as const;
    const decoded = decodeLaunchEditorInput(input);

    expect(decoded).toEqual(input);
    expect(encodeLaunchEditorInput(decoded)).toEqual(input);
  });

  it("reports the editor path for unsupported launch input on decode and encode", () => {
    const expected = {
      rootTag: "Composite" as const,
      paths: [["editor"]],
      containsTag: "AnyOf" as const,
    };
    expectDecodeFailure(LaunchEditorInput, { cwd: "/repo", editor: "not-an-editor" }, expected);
    expectEncodeFailure(LaunchEditorInput, { cwd: "/repo", editor: "not-an-editor" }, expected);
  });
});

describe("external launcher errors", () => {
  const errors = [
    new ExternalLauncherUnknownEditorError({ editor: "unknown" }),
    new ExternalLauncherUnsupportedEditorError({ editor: "file-manager" }),
    new ExternalLauncherCommandNotFoundError({ editor: "vscode", command: "code" }),
    new ExternalLauncherBrowserSpawnError({
      command: "browser",
      args: ["--new-window"],
      cause: "spawn failed",
      target: "https://example.test",
    }),
    new ExternalLauncherEditorSpawnError({
      command: "code",
      args: ["--goto"],
      cause: "spawn failed",
      editor: "vscode",
      target: "/repo/src/main.ts:4:2",
    }),
  ] as const;

  it("constructs every tagged error with a useful message", () => {
    expect(errors.map((error) => error.message)).toEqual([
      "Unknown editor: unknown",
      "Unsupported editor: file-manager",
      "Editor command not found: code",
      "Failed to launch browser target 'https://example.test' with 'browser --new-window'",
      "Failed to launch '/repo/src/main.ts:4:2' in vscode with 'code --goto'",
    ]);
    expect(errors.every(isExternalLauncherError)).toBe(true);
  });

  it("round-trips every union alternative", () => {
    for (const error of errors) {
      const encoded = encodeExternalLauncherError(error);
      const decoded = decodeExternalLauncherError(encoded);
      expect(decoded._tag).toBe(error._tag);
    }
  });

  it("reports invalid editor paths through the error union on decode and encode", () => {
    const invalid = {
      _tag: "ExternalLauncherUnsupportedEditorError",
      editor: "not-an-editor",
    };
    const expected = {
      rootTag: "AnyOf" as const,
      paths: [["editor"]],
      containsTag: "AnyOf" as const,
    };
    expectDecodeFailure(ExternalLauncherError, invalid, expected);
    expectEncodeFailure(
      ExternalLauncherError,
      makeInvalidClassInstance(ExternalLauncherUnsupportedEditorError.prototype, invalid),
      expected,
    );
  });
});
