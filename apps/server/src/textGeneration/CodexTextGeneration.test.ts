/* oxlint-disable t3code/no-global-process-runtime */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const CodexTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type FakeCodexBinaryInput = {
  output: string;
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
};

/**
 * Windows cannot execute the `#!/bin/sh` fake binary directly (CreateProcess
 * ignores shebangs), so on win32 we additionally emit a Node reimplementation
 * of the same fake CLI plus a `.cmd` launcher that `resolveSpawnCommand`
 * resolves. The POSIX shell script above is left byte-for-byte unchanged so
 * Linux/CI keep exercising the exact same fixture.
 */
function buildFakeCodexNodeScript(input: FakeCodexBinaryInput): string {
  return [
    'import * as fs from "node:fs";',
    "",
    `const input = ${JSON.stringify(input)};`,
    "",
    "const args = process.argv.slice(2);",
    'let outputPath = "";',
    'let seenImage = "0";',
    'let seenServiceTier = "";',
    'let seenReasoningEffort = "";',
    "let i = 0;",
    "while (i < args.length) {",
    "  const arg = args[i];",
    '  if (arg === "--image") {',
    "    i += 1;",
    '    if (i < args.length && typeof args[i] === "string" && args[i].length > 0) {',
    '      seenImage = "1";',
    "    }",
    "    i += 1;",
    "    continue;",
    "  }",
    '  if (arg === "--config") {',
    "    i += 1;",
    '    const value = i < args.length && typeof args[i] === "string" ? args[i] : "";',
    '    if (value.startsWith("service_tier=")) {',
    "      seenServiceTier = value;",
    "    }",
    '    if (value.startsWith("model_reasoning_effort=")) {',
    "      seenReasoningEffort = value;",
    "    }",
    "    i += 1;",
    "    continue;",
    "  }",
    '  if (arg === "--output-last-message") {',
    "    i += 1;",
    '    outputPath = i < args.length && typeof args[i] === "string" ? args[i] : "";',
    "    i += 1;",
    "    continue;",
    "  }",
    "  i += 1;",
    "}",
    "",
    'const stdinContent = fs.readFileSync(0, "utf8");',
    "",
    "function fail(message, code) {",
    '  process.stderr.write(message + "\\n");',
    "  process.exit(code);",
    "}",
    "",
    'if (input.requireImage && seenImage !== "1") {',
    '  fail("missing --image input", 2);',
    "}",
    "if (",
    "  input.requireServiceTier &&",
    "  seenServiceTier !== 'service_tier=\"' + input.requireServiceTier + '\"'",
    ") {",
    '  fail("unexpected service tier config: " + seenServiceTier, 5);',
    "}",
    "if (",
    "  input.requireReasoningEffort !== undefined &&",
    "  seenReasoningEffort !== 'model_reasoning_effort=\"' + input.requireReasoningEffort + '\"'",
    ") {",
    '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
    "}",
    "if (input.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
    '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
    "}",
    "if (input.stdinMustContain !== undefined && !stdinContent.includes(input.stdinMustContain)) {",
    '  fail("stdin missing expected content", 3);',
    "}",
    "if (",
    "  input.stdinMustNotContain !== undefined &&",
    "  stdinContent.includes(input.stdinMustNotContain)",
    ") {",
    '  fail("stdin contained forbidden content", 4);',
    "}",
    "if (input.stderr !== undefined) {",
    '  process.stderr.write(input.stderr + "\\n");',
    "}",
    "if (outputPath.length > 0) {",
    '  fs.writeFileSync(outputPath, input.output + "\\n");',
    "}",
    'process.exit(typeof input.exitCode === "number" ? input.exitCode : 0);',
    "",
  ].join("\n");
}

function makeFakeCodexBinary(dir: string, input: FakeCodexBinaryInput) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        'seen_image="0"',
        'seen_service_tier=""',
        'seen_reasoning_effort=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    case "$1" in',
        "      service_tier=*)",
        '        seen_service_tier="$1"',
        "        ;;",
        "    esac",
        '    case "$1" in',
        "      model_reasoning_effort=*)",
        '        seen_reasoning_effort="$1"',
        "        ;;",
        "    esac",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        ...(input.requireImage
          ? [
              'if [ "$seen_image" != "1" ]; then',
              '  printf "%s\\n" "missing --image input" >&2',
              `  exit 2`,
              "fi",
            ]
          : []),
        ...(input.requireServiceTier
          ? [
              `if [ "$seen_service_tier" != "service_tier=\\"${input.requireServiceTier}\\"" ]; then`,
              '  printf "%s\\n" "unexpected service tier config: $seen_service_tier" >&2',
              `  exit 5`,
              "fi",
            ]
          : []),
        ...(input.requireReasoningEffort !== undefined
          ? [
              `if [ "$seen_reasoning_effort" != "model_reasoning_effort=\\"${input.requireReasoningEffort}\\"" ]; then`,
              '  printf "%s\\n" "unexpected reasoning effort config: $seen_reasoning_effort" >&2',
              `  exit 6`,
              "fi",
            ]
          : []),
        ...(input.forbidReasoningEffort
          ? [
              'if [ -n "$seen_reasoning_effort" ]; then',
              '  printf "%s\\n" "reasoning effort config should be omitted: $seen_reasoning_effort" >&2',
              `  exit 7`,
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              `  exit 3`,
              "fi",
            ]
          : []),
        ...(input.stdinMustNotContain !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustNotContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin contained forbidden content" >&2',
              `  exit 4`,
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`,
            ]
          : []),
        'if [ -n "$output_path" ]; then',
        "  cat > \"$output_path\" <<'__T3CODE_FAKE_CODEX_OUTPUT__'",
        input.output,
        "__T3CODE_FAKE_CODEX_OUTPUT__",
        "fi",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);

    if (NodeOS.platform() === "win32") {
      const codexMjsPath = path.join(binDir, "codex.mjs");
      const codexCmdPath = path.join(binDir, "codex.cmd");
      yield* fs.writeFileString(codexMjsPath, buildFakeCodexNodeScript(input));
      yield* fs.writeFileString(
        codexCmdPath,
        `@echo off\r\n"${process.execPath}" "${codexMjsPath}" %*\r\n`,
      );
    }

    return codexPath;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireServiceTier?: string;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath });
    const textGeneration = yield* makeCodexTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGeneration", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject.length).toBeLessThanOrEqual(72);
          expect(generated.subject.endsWith(".")).toBe(false);
          expect(generated.body).toBe("- added migration\n- updated tests");
          expect(generated.branch).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "forwards codex service tier and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireServiceTier: "priority",
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        (textGeneration) =>
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ]),
          }),
      ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            includeBranch: true,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add important change");
          expect(generated.branch).toBe("feature/fix/important-system-change");
        }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/codex-effect",
            commitSummary: "feat: improve orchestration flow",
            diffSummary: "2 files changed",
            diffPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Improve orchestration flow");
          expect(generated.body.startsWith("## Summary")).toBe(true);
          expect(generated.body.endsWith("\n\n")).toBe(false);
        }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Please update session handling.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("feat/session");
        }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate websocket reconnect regressions after a worktree restore.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Investigate websocket reconnect regressions aft...");
        }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("hello world");
        }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix timeout behavior.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("fix/session-timeout");
        }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-branch-image-attachment";
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const missingAttachmentId = "thread-missing-attachment";
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("missing --image input");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );
});
