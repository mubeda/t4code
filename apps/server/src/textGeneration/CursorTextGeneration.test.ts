/* oxlint-disable t3code/no-global-process-runtime */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { CursorSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCursorTextGeneration } from "./CursorTextGeneration.ts";
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const CursorTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-cursor-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Produces a JS string literal so arbitrary env values (JSON payloads, Windows
// backslashes) can be baked into the win32 `--import` preload module. Avoids
// `JSON.stringify` per repo convention.
function toJsStringLiteral(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}"`;
}

// Windows cannot spawn a `#!/bin/sh` shebang script, so on win32 we emit an
// `agent.cmd` launcher plus a Node `--import` preload module. `resolveSpawnCommand`
// (the production spawn path) resolves the `.cmd` and runs it via `cmd.exe`,
// which forwards stdio to the single child node process — keeping the mock ACP
// agent as the entry point exactly like `exec node <agent>` on POSIX. The
// preload reproduces the shell wrapper's `acp` argument check and bakes the
// per-wrapper env so the mock agent reads the same variables at module load.
function makeWin32AcpAgentWrapper(binDir: string, env: Record<string, string>): string {
  NodeFS.mkdirSync(binDir, { recursive: true });
  const preloadPath = NodePath.join(binDir, "agent.preload.mjs");
  const cmdPath = NodePath.join(binDir, "agent.cmd");
  const lines = [
    `const __args = process.argv.slice(2);`,
    `if (__args[0] !== "acp") {`,
    `  process.stderr.write("unexpected args: " + __args.join(" ") + "\\n");`,
    `  process.exit(11);`,
    `}`,
    ...Object.entries(env).map(
      ([key, value]) => `process.env[${toJsStringLiteral(key)}] = ${toJsStringLiteral(value)};`,
    ),
  ];
  NodeFS.writeFileSync(preloadPath, `${lines.join("\n")}\n`, "utf8");
  const preloadUrl = NodeURL.pathToFileURL(preloadPath).href;
  // Windows paths never contain `"`, so plain double-quoting is sufficient (and
  // correct — unlike JSON escaping, which would mangle backslashes for cmd.exe).
  const cmd = `@echo off\r\n"${process.execPath}" --import "${preloadUrl}" "${mockAgentPath}" %*\r\n`;
  NodeFS.writeFileSync(cmdPath, cmd, "utf8");
  return cmdPath;
}

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  if (NodeOS.platform() === "win32") {
    return makeWin32AcpAgentWrapper(binDir, env);
  }
  const agentPath = NodePath.join(binDir, "agent");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec node ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const agentPath = makeAcpAgentWrapper(tempDir, env);
    const config = decodeCursorSettings({ binaryPath: agentPath });
    const textGeneration = yield* makeCursorTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function waitForFileContent(path: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 5_000;
    for (;;) {
      const result = yield* Effect.exit(Effect.sync(() => NodeFS.readFileSync(path, "utf8")));
      if (Exit.isSuccess(result)) {
        return result.value;
      }
      {
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* Effect.die(result.cause);
        }
      }
      yield* Effect.sleep(25);
    }
  });
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGeneration", (it) => {
  it.effect("uses ACP model config options instead of raw CLI model ids", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify cursor acp model config path",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-text-generation",
            stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
                { id: "reasoning", value: "xhigh" },
                { id: "fastMode", value: true },
                { id: "contextWindow", value: "1m" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify cursor acp model config path");

          const requests = NodeFS.readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            _meta: {
              parameterizedModelPicker: true,
            },
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "gpt-5.4",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "reasoning" &&
                request.params?.value === "extra-high",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "context" &&
                request.params?.value === "1m",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "fast" &&
                request.params?.value === "true",
            ),
          ).toBe(true);
          expect(
            requests.find((request) => request.method === "session/prompt")?.params?.prompt,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Staged patch:"),
              }),
            ]),
          );

          NodeFS.rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("accepts json objects with extra assistant text around them", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-noisy-json",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.subject).toBe("Update README dummy comment with attribution and date");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("generates thread titles through Cursor ACP text generation", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: '"Trim reconnect spinner status after resume."',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status after resume.");
        }),
    ),
  );

  // Skipped on win32: this test asserts the mock agent's own exit handler fires
  // (`exit:0`) when the runtime tears down the ACP child. Node cannot spawn a
  // script without an intervening `cmd.exe` (it refuses `.cmd` without a shell),
  // and effect's shutdown sends `SIGTERM` to that `cmd.exe` — which Windows
  // maps to a forced `TerminateProcess` that never reaches the orphaned grandchild
  // node process, so its graceful-exit handler cannot run. This verifies POSIX
  // single-process (`exec node`) termination semantics that have no Windows
  // equivalent from the fixture; the other tests already cover generation itself.
  it.effect.skipIf(NodeOS.platform() === "win32")(
    "closes the ACP child process after text generation completes",
    () => {
      const exitLogDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-exit-log-"),
      );
      const exitLogPath = NodePath.join(exitLogDir, "exit.log");

      return withFakeAcpAgent(
        {
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            subject: "Close runtime after generation",
            body: "",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/cursor-runtime-close",
              stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
              stagedPatch:
                "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
              modelSelection: {
                instanceId: ProviderInstanceId.make("cursor"),
                model: "composer-2",
              },
            });

            expect(generated.subject).toBe("Close runtime after generation");

            const exitLog = yield* waitForFileContent(exitLogPath);
            expect(exitLog).toContain("exit:0");

            NodeFS.rmSync(exitLogDir, { recursive: true, force: true });
          }),
      );
    },
  );
});
