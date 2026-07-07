// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";

import type { ChatAttachment } from "@t3tools/contracts";
import type { OpencodeClient, QuestionRequest } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  buildOpenCodePermissionRules,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
} from "./opencodeRuntime.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseOpenCodeModelSlug", () => {
  it("splits provider and model at the first slash", () => {
    NodeAssert.deepEqual(parseOpenCodeModelSlug("openai/gpt-4"), {
      providerID: "openai",
      modelID: "gpt-4",
    });
  });

  it("keeps later slashes inside the model id", () => {
    NodeAssert.deepEqual(parseOpenCodeModelSlug("anthropic/claude/opus"), {
      providerID: "anthropic",
      modelID: "claude/opus",
    });
  });

  it("returns null for non-string, empty, or malformed slugs", () => {
    NodeAssert.equal(parseOpenCodeModelSlug(null), null);
    NodeAssert.equal(parseOpenCodeModelSlug(undefined), null);
    NodeAssert.equal(parseOpenCodeModelSlug(42 as unknown as string), null);
    NodeAssert.equal(parseOpenCodeModelSlug("no-separator"), null);
    NodeAssert.equal(parseOpenCodeModelSlug("/leading"), null);
    NodeAssert.equal(parseOpenCodeModelSlug("trailing/"), null);
  });
});

describe("openCodeQuestionId", () => {
  const question = (header: string): QuestionRequest["questions"][number] =>
    ({
      header,
      question: "Which option?",
      options: [],
    }) as unknown as QuestionRequest["questions"][number];

  it("slugifies the header into a stable id", () => {
    NodeAssert.equal(
      openCodeQuestionId(0, question("Approve This Action!")),
      "question-0-approve-this-action-",
    );
  });

  it("falls back to the index when the header slug is empty", () => {
    NodeAssert.equal(openCodeQuestionId(3, question("   ")), "question-3");
  });
});

describe("toOpenCodeFileParts", () => {
  const attachment = (overrides: Partial<ChatAttachment> = {}): ChatAttachment =>
    ({
      type: "image",
      id: "att-1",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
      ...overrides,
    }) as ChatAttachment;

  it("maps resolvable attachments to file parts with file:// urls", () => {
    const parts = toOpenCodeFileParts({
      attachments: [
        attachment(),
        attachment({ id: "att-2", name: "b.png" } as Partial<ChatAttachment>),
      ],
      resolveAttachmentPath: (a) => `/tmp/${a.id}.png`,
    });

    NodeAssert.equal(parts.length, 2);
    NodeAssert.equal(parts[0]?.type, "file");
    NodeAssert.equal(parts[0]?.mime, "image/png");
    NodeAssert.equal(parts[0]?.filename, "shot.png");
    NodeAssert.match(parts[0]?.url ?? "", /^file:\/\/.*att-1\.png$/);
  });

  it("skips attachments that cannot be resolved and tolerates undefined lists", () => {
    NodeAssert.deepEqual(
      toOpenCodeFileParts({ attachments: [attachment()], resolveAttachmentPath: () => null }),
      [],
    );
    NodeAssert.deepEqual(
      toOpenCodeFileParts({ attachments: undefined, resolveAttachmentPath: () => "/tmp/x" }),
      [],
    );
  });
});

describe("buildOpenCodePermissionRules", () => {
  it("returns a single wildcard allow rule for full access", () => {
    NodeAssert.deepEqual(buildOpenCodePermissionRules("full-access"), [
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  it("returns the ask ruleset for constrained modes", () => {
    const rules = buildOpenCodePermissionRules("approval-required");
    NodeAssert.ok(rules.length > 1);
    NodeAssert.ok(rules.some((rule) => rule.permission === "bash" && rule.action === "ask"));
    NodeAssert.ok(rules.some((rule) => rule.permission === "question" && rule.action === "allow"));
  });
});

describe("toOpenCodePermissionReply", () => {
  it("maps provider decisions to opencode permission replies", () => {
    NodeAssert.equal(toOpenCodePermissionReply("accept"), "once");
    NodeAssert.equal(toOpenCodePermissionReply("acceptForSession"), "always");
    NodeAssert.equal(toOpenCodePermissionReply("decline"), "reject");
    NodeAssert.equal(toOpenCodePermissionReply("cancel"), "reject");
  });
});

describe("toOpenCodeQuestionAnswers", () => {
  const request: QuestionRequest = {
    questions: [
      { header: "Scope", question: "Pick a scope", options: [] },
      { header: "Mode", question: "Pick a mode", options: [] },
    ],
  } as unknown as QuestionRequest;

  it("resolves answers by generated id, header, and question text", () => {
    const answers = toOpenCodeQuestionAnswers(request, {
      [openCodeQuestionId(0, request.questions[0]!)]: "workspace",
      Mode: "  plan  ",
    });

    NodeAssert.deepEqual(answers[0], ["workspace"]);
    NodeAssert.deepEqual(answers[1], ["  plan  "]);
  });

  it("filters arrays to strings and drops blank or non-string values", () => {
    const answers = toOpenCodeQuestionAnswers(request, {
      Scope: ["a", 5, "b"] as unknown as string[],
      Mode: "   ",
    });

    NodeAssert.deepEqual(answers[0], ["a", "b"]);
    NodeAssert.deepEqual(answers[1], []);
  });

  it("returns empty arrays when no answer is present", () => {
    const answers = toOpenCodeQuestionAnswers(request, {});
    NodeAssert.deepEqual(answers, [[], []]);
  });
});

describe("openCodeRuntimeErrorDetail", () => {
  it("returns the detail from an OpenCodeRuntimeError", () => {
    const error = new OpenCodeRuntimeError({ operation: "x", detail: "boom detail" });
    NodeAssert.equal(openCodeRuntimeErrorDetail(error), "boom detail");
  });

  it("returns a trimmed Error message", () => {
    NodeAssert.equal(openCodeRuntimeErrorDetail(new Error("  spawn failure  ")), "spawn failure");
  });

  it("summarizes SDK-style response error shapes", () => {
    const detail = openCodeRuntimeErrorDetail({
      response: { status: 503 },
      error: { message: "unavailable" },
    });
    NodeAssert.match(detail, /status=503/);
    NodeAssert.match(detail, /unavailable/);
  });

  it("falls back to String(cause) for primitive causes", () => {
    NodeAssert.equal(openCodeRuntimeErrorDetail("plain string cause"), "plain string cause");
  });

  it("guards its own tag via OpenCodeRuntimeError.is", () => {
    NodeAssert.equal(
      OpenCodeRuntimeError.is(new OpenCodeRuntimeError({ operation: "x", detail: "y" })),
      true,
    );
    NodeAssert.equal(OpenCodeRuntimeError.is(new Error("nope")), false);
    NodeAssert.equal(OpenCodeRuntimeError.is(null), false);
  });
});

// ---------------------------------------------------------------------------
// Runtime layer (fake CLI + mock SDK client)
// ---------------------------------------------------------------------------

const OpenCodeRuntimeTestLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

type FakeOpencodeSpec =
  | {
      readonly kind: "command";
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number;
    }
  | { readonly kind: "server-ready" }
  | { readonly kind: "server-exit"; readonly stderr?: string; readonly exitCode?: number }
  | { readonly kind: "server-hang" };

function buildFakeOpencodeNodeScript(spec: FakeOpencodeSpec): string {
  switch (spec.kind) {
    case "command":
      return [
        `const spec = ${JSON.stringify(spec)};`,
        'if (typeof spec.stdout === "string") process.stdout.write(spec.stdout);',
        'if (typeof spec.stderr === "string") process.stderr.write(spec.stderr);',
        'process.exit(typeof spec.exitCode === "number" ? spec.exitCode : 0);',
        "",
      ].join("\n");
    case "server-ready":
      return [
        "const args = process.argv.slice(2);",
        'let host = "127.0.0.1";',
        'let port = "0";',
        "for (const arg of args) {",
        '  if (arg.startsWith("--hostname=")) host = arg.slice("--hostname=".length);',
        '  if (arg.startsWith("--port=")) port = arg.slice("--port=".length);',
        "}",
        "process.stdout.write(`opencode server listening on http://${host}:${port}\\n`);",
        "setInterval(() => {}, 100000);",
        "",
      ].join("\n");
    case "server-exit":
      return [
        `const spec = ${JSON.stringify(spec)};`,
        'if (typeof spec.stderr === "string") process.stderr.write(spec.stderr);',
        'process.exit(typeof spec.exitCode === "number" ? spec.exitCode : 1);',
        "",
      ].join("\n");
    case "server-hang":
      return ["setInterval(() => {}, 100000);", ""].join("\n");
  }
}

function buildFakeOpencodeShellScript(spec: FakeOpencodeSpec): string {
  switch (spec.kind) {
    case "command":
      return [
        "#!/bin/sh",
        ...(typeof spec.stdout === "string" ? [`printf '%s' ${JSON.stringify(spec.stdout)}`] : []),
        ...(typeof spec.stderr === "string"
          ? [`printf '%s' ${JSON.stringify(spec.stderr)} >&2`]
          : []),
        `exit ${spec.exitCode ?? 0}`,
        "",
      ].join("\n");
    case "server-ready":
      return [
        "#!/bin/sh",
        "host=127.0.0.1",
        "port=0",
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    --hostname=*) host="${arg#--hostname=}" ;;',
        '    --port=*) port="${arg#--port=}" ;;',
        "  esac",
        "done",
        'printf "opencode server listening on http://%s:%s\\n" "$host" "$port"',
        "while true; do sleep 1; done",
        "",
      ].join("\n");
    case "server-exit":
      return [
        "#!/bin/sh",
        ...(typeof spec.stderr === "string"
          ? [`printf '%s' ${JSON.stringify(spec.stderr)} >&2`]
          : []),
        `exit ${spec.exitCode ?? 1}`,
        "",
      ].join("\n");
    case "server-hang":
      return ["#!/bin/sh", "while true; do sleep 1; done", ""].join("\n");
  }
}

function makeFakeOpencodeBinary(dir: string, spec: FakeOpencodeSpec) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const opencodePath = path.join(binDir, "opencode");
    yield* fs.makeDirectory(binDir, { recursive: true });
    yield* fs.writeFileString(opencodePath, buildFakeOpencodeShellScript(spec));
    yield* fs.chmod(opencodePath, 0o755);

    const platform = yield* HostProcessPlatform;
    if (platform === "win32") {
      const mjsPath = path.join(binDir, "opencode.mjs");
      const cmdPath = path.join(binDir, "opencode.cmd");
      yield* fs.writeFileString(mjsPath, buildFakeOpencodeNodeScript(spec));
      yield* fs.writeFileString(cmdPath, `@echo off\r\n"${process.execPath}" "${mjsPath}" %*\r\n`);
    }

    return opencodePath;
  });
}

function withFakeBinary<A, E, R>(
  spec: FakeOpencodeSpec,
  use: (binaryPath: string) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-runtime-test-" });
    const binaryPath = yield* makeFakeOpencodeBinary(dir, spec);
    return yield* use(binaryPath);
  }).pipe(Effect.scoped);
}

function makeInventoryClient(input: {
  readonly providers?: unknown;
  readonly agents?: ReadonlyArray<unknown>;
  readonly providerThrows?: boolean;
}): OpencodeClient {
  return {
    provider: {
      list: () =>
        input.providerThrows
          ? Promise.reject(new Error("provider list boom"))
          : Promise.resolve({ data: input.providers }),
    },
    app: {
      agents: () => Promise.resolve({ data: input.agents ?? [] }),
    },
  } as unknown as OpencodeClient;
}

it.layer(OpenCodeRuntimeTestLayer)("OpenCodeRuntime", (it) => {
  it.effect("runOpenCodeCommand captures stdout, stderr, and exit code", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const result = yield* withFakeBinary(
        { kind: "command", stdout: "opencode 1.2.3", stderr: "a warning", exitCode: 0 },
        (binaryPath) => runtime.runOpenCodeCommand({ binaryPath, args: ["--version"] }),
      );

      NodeAssert.equal(result.code, 0);
      NodeAssert.match(result.stdout, /opencode 1\.2\.3/);
      NodeAssert.match(result.stderr, /a warning/);
    }),
  );

  it.effect("runOpenCodeCommand returns non-zero exit codes without failing", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const result = yield* withFakeBinary(
        { kind: "command", stdout: "partial", exitCode: 3 },
        (binaryPath) => runtime.runOpenCodeCommand({ binaryPath, args: ["run"] }),
      );

      NodeAssert.equal(result.code, 3);
      NodeAssert.match(result.stdout, /partial/);
    }),
  );

  it.effect("runOpenCodeCommand surfaces a typed error when the binary is missing", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime
        .runOpenCodeCommand({
          binaryPath: "t3-opencode-does-not-exist-xyz",
          args: ["--version"],
        })
        .pipe(Effect.result);

      NodeAssert.equal(Result.isFailure(result), true);
      if (Result.isFailure(result)) {
        NodeAssert.equal(OpenCodeRuntimeError.is(result.failure), true);
        NodeAssert.equal(result.failure.operation, "runOpenCodeCommand");
      }
    }),
  );

  it.effect("createOpenCodeSdkClient constructs clients with and without a password", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = runtime.createOpenCodeSdkClient({
        baseUrl: "http://127.0.0.1:4096",
        directory: process.cwd(),
      });
      NodeAssert.ok(client);
      NodeAssert.ok(client.provider);

      const secured = runtime.createOpenCodeSdkClient({
        baseUrl: "http://127.0.0.1:4096",
        directory: process.cwd(),
        serverPassword: "hunter2",
      });
      NodeAssert.ok(secured);
    }),
  );

  it.effect("loadOpenCodeInventory returns providers and agents from the SDK client", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = makeInventoryClient({
        providers: { providers: [], default: {} },
        agents: [{ name: "build" }],
      });

      const inventory = yield* runtime.loadOpenCodeInventory(client);
      NodeAssert.deepEqual(inventory.providerList, { providers: [], default: {} });
      NodeAssert.equal(inventory.agents.length, 1);
    }),
  );

  it.effect("loadOpenCodeInventory fails when the provider list is empty", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = makeInventoryClient({ providers: undefined });

      const result = yield* runtime.loadOpenCodeInventory(client).pipe(Effect.result);
      NodeAssert.equal(Result.isFailure(result), true);
      if (Result.isFailure(result)) {
        NodeAssert.equal(OpenCodeRuntimeError.is(result.failure), true);
        NodeAssert.equal(result.failure.operation, "provider.list");
      }
    }),
  );

  it.effect("loadOpenCodeInventory maps SDK rejections to typed runtime errors", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = makeInventoryClient({ providerThrows: true });

      const result = yield* runtime.loadOpenCodeInventory(client).pipe(Effect.result);
      NodeAssert.equal(Result.isFailure(result), true);
      if (Result.isFailure(result)) {
        NodeAssert.equal(OpenCodeRuntimeError.is(result.failure), true);
        NodeAssert.match(result.failure.detail, /provider list boom/);
      }
    }),
  );

  it.effect("connectToOpenCodeServer returns external handles without spawning", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const connection = yield* runtime.connectToOpenCodeServer({
        binaryPath: "unused",
        serverUrl: "  http://example.test:9000  ",
      });

      NodeAssert.equal(connection.external, true);
      NodeAssert.equal(connection.url, "http://example.test:9000");
      NodeAssert.equal(connection.exitCode, null);
    }),
  );

  it.effect("startOpenCodeServerProcess resolves the server url from stdout", () =>
    withFakeBinary({ kind: "server-ready" }, (binaryPath) =>
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath,
          port: 61999,
          hostname: "127.0.0.1",
          timeoutMs: 5000,
        });

        NodeAssert.equal(server.url, "http://127.0.0.1:61999");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("connectToOpenCodeServer spawns a local server when no url is provided", () =>
    withFakeBinary({ kind: "server-ready" }, (binaryPath) =>
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        const connection = yield* runtime.connectToOpenCodeServer({
          binaryPath,
          port: 61998,
          timeoutMs: 5000,
        });

        NodeAssert.equal(connection.external, false);
        NodeAssert.equal(connection.url, "http://127.0.0.1:61998");
        NodeAssert.notEqual(connection.exitCode, null);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("startOpenCodeServerProcess fails when the server exits before startup", () =>
    withFakeBinary({ kind: "server-exit", stderr: "fatal boot error", exitCode: 1 }, (binaryPath) =>
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        const result = yield* runtime
          .startOpenCodeServerProcess({ binaryPath, port: 61997, timeoutMs: 5000 })
          .pipe(Effect.result);

        NodeAssert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          NodeAssert.equal(OpenCodeRuntimeError.is(result.failure), true);
          NodeAssert.equal(result.failure.operation, "startOpenCodeServerProcess");
        }
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("startOpenCodeServerProcess times out when the ready line never arrives", () =>
    withFakeBinary({ kind: "server-hang" }, (binaryPath) =>
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        const result = yield* runtime
          .startOpenCodeServerProcess({ binaryPath, port: 61996, timeoutMs: 100 })
          .pipe(Effect.result);

        NodeAssert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          NodeAssert.equal(OpenCodeRuntimeError.is(result.failure), true);
          NodeAssert.match(result.failure.detail, /Timed out waiting/);
        }
      }).pipe(Effect.scoped),
    ),
  );
});
