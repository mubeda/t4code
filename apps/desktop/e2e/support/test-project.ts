// @effect-diagnostics nodeBuiltinImport:off - The packaged smoke fixture owns host temp files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const FIXTURE_PROJECT_NAME = "T4Code UI Fixture";
const STREAMED_RESPONSE = "T4Code deterministic streamed fixture response.";

export const composerProviderProfiles = {
  codex: {
    commands: ["goal"],
    slashSkills: [],
    dollarSkills: ["refactor"],
    mentionableAgents: [],
  },
  claudeAgent: {
    commands: ["compact", "goal", "loop"],
    slashSkills: ["docs"],
    dollarSkills: [],
    mentionableAgents: [],
  },
  cursor: {
    commands: [
      "review",
      "models",
      "auto-run",
      "new-chat",
      "vim",
      "help",
      "feedback",
      "resume",
      "copy-req-id",
      "rules",
      "commands",
      "mcp",
      "max-mode",
      "compress",
      "add-plugin",
      "logout",
      "quit",
    ],
    slashSkills: ["frontend"],
    dollarSkills: [],
    mentionableAgents: [],
  },
  opencode: {
    commands: ["init"],
    slashSkills: [],
    dollarSkills: [],
    mentionableAgents: ["reviewer", "operator"],
  },
  grok: {
    commands: ["loop", "agents", "skills"],
    slashSkills: [],
    dollarSkills: [],
    mentionableAgents: [],
  },
} as const;

export interface DesktopUiTestContext {
  readonly runRoot: string;
  readonly stateRoot: string;
  readonly projectPath: string;
  readonly shimDirectory: string;
  readonly artifactDirectory: string;
  readonly fixtureUserHomePath: string;
  readonly providerInputLogPath: string;
}

export type DesktopUiDirectoryRemover = (path: string, options: NodeFS.RmDirOptions) => void;

export interface DesktopUiExitRegistrar {
  once(event: "exit", listener: () => void): unknown;
}

export type DesktopUiTestContextCleaner = (context: DesktopUiTestContext) => void;

const codexFixtureSource = String.raw`
import readline from "node:readline";
import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 99.0.0-fixture\n");
  process.exit(0);
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const streamResponse = ${JSON.stringify(STREAMED_RESPONSE)};
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on("line", (line) => {
  const message = JSON.parse(line);
  const id = message.id;
  switch (message.method) {
    case "initialize":
      send({ id, result: {
        userAgent: "t4code-ui-fixture",
        codexHome: "/tmp/t4code-ui-codex",
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform
      } });
      break;
    case "account/read":
      send({ id, result: {
        account: { type: "chatgpt", email: "fixture@example.test", planType: "fixture" },
        requiresOpenaiAuth: false
      } });
      break;
    case "model/list":
      send({ id, result: {
        data: message.params?.cursor ? [] : [{
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          defaultReasoningEffort: "medium"
        }],
        nextCursor: null
      } });
      break;
    case "skills/list":
      send({ id, result: {
        data: [{
          cwd: message.params?.cwds?.[0] ?? process.cwd(),
          skills: [{
            name: "refactor",
            path: "/fixture/.codex/skills/refactor/SKILL.md",
            enabled: true,
            description: "Refactor the deterministic fixture.",
            scope: "project",
            interface: {
              displayName: "Refactor",
              shortDescription: "Refactor the deterministic fixture."
            }
          }]
        }]
      } });
      break;
    case "thread/start":
    case "thread/resume":
      send({ id, result: {
        cwd: message.params?.cwd ?? process.cwd(),
        model: "gpt-5.4",
        thread: { id: "t4code-ui-provider-thread" }
      } });
      break;
    case "thread/goal/set":
      send({ id, result: { goal: { status: "active" } } });
      break;
    case "turn/start": {
      const turnId = "t4code-ui-turn";
      appendProviderInput("codex", promptTextFromParts(message.params?.input));
      send({ id, result: { turn: { id: turnId } } });
      send({ method: "turn/started", params: {
        threadId: "t4code-ui-provider-thread",
        turn: { id: turnId }
      } });
      send({ method: "item/agentMessage/delta", params: {
        threadId: "t4code-ui-provider-thread",
        turnId,
        itemId: "t4code-ui-message",
        delta: streamResponse
      } });
      send({ method: "turn/completed", params: {
        threadId: "t4code-ui-provider-thread",
        turn: { id: turnId, status: "completed" }
      } });
      break;
    }
    case "turn/interrupt":
    case "shutdown":
      send({ id, result: null });
      break;
    default:
      if (id !== undefined) send({ id, result: {} });
  }
});
`.trimStart();

const providerInputLogFixtureSource = String.raw`
import * as NodeFS from "node:fs";

export function promptTextFromParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function appendProviderInput(provider, prompt) {
  const path = process.env.T4CODE_E2E_PROVIDER_INPUT_LOG;
  if (!path) {
    throw new Error("T4CODE_E2E_PROVIDER_INPUT_LOG is required.");
  }
  NodeFS.appendFileSync(path, JSON.stringify({
    provider,
    prompt,
    recordedAt: new Date().toISOString()
  }) + "\n", "utf8");
}
`.trimStart();

const claudeFixtureSource = String.raw`
import readline from "node:readline";
import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.200 (Claude Code)\n");
  process.exit(0);
}
if (process.argv.includes("auth") && process.argv.includes("status")) {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    email: "fixture@example.test",
    authMethod: "fixture"
  }) + "\n");
  process.exit(0);
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const streamResponse = ${JSON.stringify(STREAMED_RESPONSE)};
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    const request = message.request ?? {};
    const subtype = request.subtype ?? request.request?.subtype;
    const requestId = message.request_id ?? request.request_id;
    if (subtype === "initialize" && requestId) {
      send({
        type: "control_response",
        response: {
          request_id: requestId,
          subtype: "success",
          response: {
            commands: [{
              name: "compact",
              description: "Compact the deterministic fixture context."
            }],
            agents: [{
              name: "claude-prose-agent",
              description: "Prose-only upstream agent without inline invocation metadata."
            }]
          }
        }
      });
    } else if (subtype === "reload_skills" && requestId) {
      send({
        type: "control_response",
        response: {
          request_id: requestId,
          subtype: "success",
          response: {
            skills: [{
              name: "docs",
              description: "Use deterministic fixture documentation."
            }]
          }
        }
      });
    }
    return;
  }
  if (message.type !== "user") {
    return;
  }
  const sessionId = message.session_id ?? "t4code-ui-claude-session";
  appendProviderInput("claudeAgent", promptTextFromParts(message.message?.content));
  send({
    type: "stream_event",
    session_id: sessionId,
    uuid: "t4code-ui-claude-stream",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: streamResponse }
    }
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    stop_reason: "end_turn",
    session_id: sessionId,
    uuid: "t4code-ui-claude-result"
  });
});
`.trimStart();

const cursorFixtureSource = String.raw`
import readline from "node:readline";
import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";

if (process.argv.includes("--version")) {
  process.stdout.write("cursor-agent 99.0.0-fixture\n");
  process.exit(0);
}
if (process.argv.includes("about")) {
  process.stdout.write(JSON.stringify({
    cliVersion: "99.0.0-fixture",
    userEmail: "fixture@example.test",
    subscriptionTier: "fixture"
  }) + "\n");
  process.exit(0);
}

const send = (id, result) => process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id,
  result
}) + "\n");
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
    case "authenticate":
    case "session/set_mode":
      send(message.id, {});
      break;
    case "cursor/list_available_models":
      send(message.id, {
        models: [{
          value: "cursor-fixture",
          name: "Cursor Fixture",
          configOptions: []
        }]
      });
      break;
    case "session/new":
    case "session/load":
      send(message.id, {
        sessionId: message.params?.sessionId ?? "t4code-ui-cursor-session",
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "cursor-fixture",
          options: [{ value: "cursor-fixture", name: "Cursor Fixture" }]
        }],
        modes: {
          currentModeId: "ask",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Agent" },
            { id: "architect", name: "Plan" }
          ]
        }
      });
      break;
    case "session/set_config_option":
      send(message.id, { configOptions: [] });
      break;
    case "session/prompt":
      appendProviderInput("cursor", promptTextFromParts(message.params?.prompt));
      send(message.id, { stopReason: "end_turn" });
      break;
    case "session/cancel":
      send(message.id, {});
      break;
    default:
      if (message.id !== undefined) {
        send(message.id, {});
      }
  }
});
`.trimStart();

const grokFixtureSource = String.raw`
import readline from "node:readline";
import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";

if (process.argv.includes("--version")) {
  process.stdout.write("grok-cli 99.0.0-fixture\n");
  process.exit(0);
}

const send = (id, result) => process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id,
  result
}) + "\n");
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
    case "authenticate":
    case "session/set_mode":
    case "session/set_model":
      send(message.id, {});
      break;
    case "session/create":
    case "session/load":
      send(message.id, {
        sessionId: message.params?.sessionId ?? "t4code-ui-grok-session",
        modes: {
          currentModeId: "code",
          availableModes: [
            { id: "code", name: "Agent" },
            { id: "ask", name: "Ask" }
          ]
        }
      });
      break;
    case "session/prompt":
      appendProviderInput("grok", promptTextFromParts(message.params?.prompt));
      send(message.id, { stopReason: "end_turn" });
      break;
    case "session/cancel":
      send(message.id, {});
      break;
    default:
      if (message.id !== undefined) {
        send(message.id, {});
      }
  }
});
`.trimStart();

const opencodeFixtureSource = String.raw`
import * as NodeHTTP from "node:http";
import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";

if (process.argv.includes("--version")) {
  process.stdout.write("opencode 99.0.0-fixture\n");
  process.exit(0);
}

const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length));
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("OpenCode fixture requires --port=<port>.");
}

const eventClients = new Set();
const sendJson = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return chunks.length === 0
    ? {}
    : JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const broadcast = (event) => {
  const frame = "data: " + JSON.stringify(event) + "\n\n";
  for (const response of eventClients) {
    response.write(frame);
  }
};

const server = NodeHTTP.createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && pathname === "/global/health") {
    sendJson(response, { healthy: true });
    return;
  }
  if (request.method === "GET" && pathname === "/provider") {
    sendJson(response, {
      connected: ["openai"],
      all: [{
        id: "openai",
        models: {
          "gpt-5": { name: "GPT-5 Fixture" }
        }
      }]
    });
    return;
  }
  if (request.method === "GET" && pathname === "/agent") {
    sendJson(response, [
      { name: "writer", mode: "primary", description: "Prose-only primary agent." },
      { name: "reviewer", mode: "subagent", description: "Mentionable review agent." },
      { name: "operator", mode: "all", description: "Mentionable all-mode agent." },
      { name: "secret", mode: "subagent", hidden: true, description: "Hidden agent." }
    ]);
    return;
  }
  if (request.method === "GET" && pathname === "/command") {
    sendJson(response, [{
      name: "init",
      description: "Initialize the deterministic fixture."
    }]);
    return;
  }
  if (request.method === "GET" && pathname === "/event") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    response.write(": connected\n\n");
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
    return;
  }
  if (request.method === "POST" && pathname === "/session") {
    await readJson(request);
    sendJson(response, { id: "t4code-ui-opencode-session" });
    return;
  }
  if (request.method === "GET" && pathname === "/session/t4code-ui-opencode-session") {
    sendJson(response, { id: "t4code-ui-opencode-session" });
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/session/t4code-ui-opencode-session/prompt_async"
  ) {
    const body = await readJson(request);
    appendProviderInput("opencode", promptTextFromParts(body.parts));
    sendJson(response, {});
    setTimeout(() => {
      broadcast({
        type: "session.status",
        properties: {
          sessionID: "t4code-ui-opencode-session",
          status: { type: "idle" }
        }
      });
    }, 10);
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/session/t4code-ui-opencode-session/command"
  ) {
    const body = await readJson(request);
    appendProviderInput(
      "opencode",
      "/" + String(body.command ?? "") +
        (body.arguments ? " " + String(body.arguments) : "")
    );
    sendJson(response, {});
    setTimeout(() => {
      broadcast({
        type: "session.status",
        properties: {
          sessionID: "t4code-ui-opencode-session",
          status: { type: "idle" }
        }
      });
    }, 10);
    return;
  }
  if (request.method === "POST" && pathname.endsWith("/abort")) {
    sendJson(response, {});
    return;
  }
  if (request.method === "GET" && pathname.endsWith("/message")) {
    sendJson(response, { data: [] });
    return;
  }
  if (request.method === "POST" && pathname.endsWith("/revert")) {
    sendJson(response, {});
    return;
  }
  if (request.method === "POST" && pathname === "/t4code-fixture/shutdown") {
    sendJson(response, { shuttingDown: true });
    setTimeout(close, 0);
    return;
  }
  sendJson(response, {});
});

server.listen(port, "127.0.0.1");
const close = () => {
  for (const response of eventClients) {
    response.end();
  }
  eventClients.clear();
  server.close(() => process.exit(0));
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
`.trimStart();

function writeExecutable(path: string, contents: string, isWindows: boolean): void {
  NodeFS.writeFileSync(path, contents);
  if (!isWindows) {
    NodeFS.chmodSync(path, 0o755);
  }
}

function createProviderShims(shimDirectory: string, isWindows: boolean): void {
  const fixtureSources = {
    codex: codexFixtureSource,
    claude: claudeFixtureSource,
    "cursor-agent": cursorFixtureSource,
    grok: grokFixtureSource,
    opencode: opencodeFixtureSource,
  } as const;
  NodeFS.writeFileSync(
    NodePath.join(shimDirectory, "provider-input-log-fixture.mjs"),
    providerInputLogFixtureSource,
  );
  for (const [provider, source] of Object.entries(fixtureSources)) {
    NodeFS.writeFileSync(NodePath.join(shimDirectory, `${provider}-fixture.mjs`), source);
  }

  if (isWindows) {
    for (const provider of Object.keys(fixtureSources)) {
      NodeFS.writeFileSync(
        NodePath.join(shimDirectory, `${provider}.cmd`),
        `@node "%~dp0\\${provider}-fixture.mjs" %*\r\n`,
      );
    }
    return;
  }

  for (const provider of Object.keys(fixtureSources)) {
    writeExecutable(
      NodePath.join(shimDirectory, provider),
      `#!/bin/sh\nexec node "$(dirname "$0")/${provider}-fixture.mjs" "$@"\n`,
      false,
    );
  }
}

function writeProviderSettings(
  stateRoot: string,
  shimDirectory: string,
  fixtureUserHomePath: string,
  isWindows: boolean,
): void {
  const executablePath = (name: string): string =>
    NodePath.join(shimDirectory, isWindows ? `${name}.cmd` : name);
  const userDataDirectory = NodePath.join(stateRoot, "userdata");
  NodeFS.mkdirSync(userDataDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(userDataDirectory, "settings.json"),
    `${JSON.stringify(
      {
        providers: {
          codex: { enabled: true, binaryPath: executablePath("codex") },
          claudeAgent: { enabled: true, binaryPath: executablePath("claude") },
          cursor: { enabled: true, binaryPath: executablePath("cursor-agent") },
          grok: { enabled: true, binaryPath: executablePath("grok") },
          opencode: { enabled: true, binaryPath: executablePath("opencode") },
        },
        providerInstances: {
          cursor: {
            driver: "cursor",
            enabled: true,
            environment: [
              {
                name: isWindows ? "USERPROFILE" : "HOME",
                value: fixtureUserHomePath,
                sensitive: false,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function runGit(projectPath: string, args: ReadonlyArray<string>): void {
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "-C",
      projectPath,
      "-c",
      "user.name=T4Code UI Fixture",
      "-c",
      "user.email=fixture@example.test",
      ...args,
    ],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    throw new Error(`UI fixture Git command failed: ${result.stderr}`);
  }
}

function initializeGitProject(projectPath: string): void {
  NodeFS.mkdirSync(projectPath, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(projectPath, "README.md"),
    "# T4Code packaged desktop UI fixture\n",
  );
  const projectFiles = {
    ".claude/skills/docs/SKILL.md": [
      "---",
      "name: docs",
      "description: Use deterministic fixture documentation.",
      "---",
      "",
      "# Docs",
      "",
      "Use the packaged fixture documentation.",
      "",
    ].join("\n"),
    ".cursor/commands/review.md": "# Review\n\nReview the deterministic fixture.\n",
    ".cursor/skills/frontend/SKILL.md": [
      "---",
      "name: frontend",
      "description: Exercise the deterministic frontend fixture.",
      "---",
      "",
      "# Frontend",
      "",
      "Exercise the packaged frontend fixture.",
      "",
    ].join("\n"),
    ".cursor/agents/cursor-prose-agent.md": [
      "# Cursor prose agent",
      "",
      "This upstream fixture intentionally has no inline invocation metadata.",
      "",
    ].join("\n"),
  } as const;
  for (const [relativePath, contents] of Object.entries(projectFiles)) {
    const path = NodePath.join(projectPath, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, contents);
  }
  if (NodeFS.existsSync(NodePath.join(projectPath, ".git"))) return;
  runGit(projectPath, ["init", "--initial-branch=main"]);
  runGit(projectPath, ["add", "."]);
  runGit(projectPath, ["commit", "-m", "fixture"]);
}

export function prepareDesktopUiTestContext(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopUiTestContext {
  const runRoot =
    environment.T4CODE_E2E_RUN_ROOT ??
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4code-desktop-ui-"));
  const artifactDirectory =
    environment.T4CODE_E2E_ARTIFACT_DIR ??
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4code-desktop-ui-artifacts-"));
  const stateRoot = NodePath.join(runRoot, "state");
  const projectPath = NodePath.join(runRoot, "projects with spaces", FIXTURE_PROJECT_NAME);
  const shimDirectory = NodePath.join(runRoot, "provider-shims");
  const fixtureUserHomePath = NodePath.join(runRoot, "fixture-user-home");
  const providerInputLogPath = NodePath.join(runRoot, "provider-input.jsonl");

  NodeFS.mkdirSync(stateRoot, { recursive: true });
  NodeFS.mkdirSync(shimDirectory, { recursive: true });
  NodeFS.mkdirSync(fixtureUserHomePath, { recursive: true });
  NodeFS.mkdirSync(artifactDirectory, { recursive: true });
  NodeFS.writeFileSync(providerInputLogPath, "");
  initializeGitProject(projectPath);
  // oxlint-disable-next-line t4code/no-global-process-runtime -- The standalone WDIO fixture injects the detected host into its adapters.
  const hostPlatform = environment.T4CODE_E2E_PLATFORM ?? process.platform;
  const isWindows = hostPlatform === "win" || hostPlatform === "win32";
  createProviderShims(shimDirectory, isWindows);
  writeProviderSettings(stateRoot, shimDirectory, fixtureUserHomePath, isWindows);

  environment.T4CODE_E2E_RUN_ROOT = runRoot;
  environment.T4CODE_E2E_ARTIFACT_DIR = artifactDirectory;
  environment.T4CODE_E2E_PROJECT_PATH = projectPath;
  environment.T4CODE_E2E_SHIM_DIRECTORY = shimDirectory;
  environment.T4CODE_E2E_USER_HOME = fixtureUserHomePath;
  environment.T4CODE_E2E_PROVIDER_INPUT_LOG = providerInputLogPath;
  environment.T4CODE_HOME = stateRoot;
  if (isWindows) {
    environment.USERPROFILE = fixtureUserHomePath;
    environment.HOME = fixtureUserHomePath;
  } else {
    environment.HOME = fixtureUserHomePath;
  }
  environment.PATH = `${shimDirectory}${NodePath.delimiter}${environment.PATH ?? ""}`;
  environment.RUST_LOG ??= "t4code=debug";

  return {
    runRoot,
    stateRoot,
    projectPath,
    shimDirectory,
    artifactDirectory,
    fixtureUserHomePath,
    providerInputLogPath,
  };
}

export function archiveAndCleanupDesktopUiTestContext(
  context: DesktopUiTestContext,
  removeDirectory: DesktopUiDirectoryRemover = NodeFS.rmSync,
): void {
  const archivedState = NodePath.join(context.artifactDirectory, "state");
  if (NodeFS.existsSync(context.stateRoot)) {
    NodeFS.cpSync(context.stateRoot, archivedState, { recursive: true, force: true });
  }
  if (NodeFS.existsSync(context.providerInputLogPath)) {
    NodeFS.copyFileSync(
      context.providerInputLogPath,
      NodePath.join(context.artifactDirectory, "provider-input.jsonl"),
    );
  }
  removeDirectory(context.runRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

export function deferDesktopUiTestContextCleanupUntilExit(
  context: DesktopUiTestContext,
  exitRegistrar: DesktopUiExitRegistrar,
  cleanContext: DesktopUiTestContextCleaner = archiveAndCleanupDesktopUiTestContext,
): void {
  exitRegistrar.once("exit", () => {
    cleanContext(context);
  });
}

export const desktopUiFixture = {
  projectName: FIXTURE_PROJECT_NAME,
  streamedResponse: STREAMED_RESPONSE,
} as const;
