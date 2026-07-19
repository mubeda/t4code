// @effect-diagnostics nodeBuiltinImport:off - The packaged smoke fixture owns host temp files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const FIXTURE_PROJECT_NAME = "T4Code UI Fixture";
const STREAMED_RESPONSE = "T4Code deterministic streamed fixture response.";

export interface DesktopUiTestContext {
  readonly runRoot: string;
  readonly stateRoot: string;
  readonly projectPath: string;
  readonly shimDirectory: string;
  readonly artifactDirectory: string;
}

export type DesktopUiDirectoryRemover = (path: string, options: NodeFS.RmDirOptions) => void;

export interface DesktopUiExitRegistrar {
  once(event: "exit", listener: () => void): unknown;
}

export type DesktopUiTestContextCleaner = (context: DesktopUiTestContext) => void;

const codexFixtureSource = String.raw`
import readline from "node:readline";

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
      send({ id, result: { data: [] } });
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

function writeExecutable(path: string, contents: string, isWindows: boolean): void {
  NodeFS.writeFileSync(path, contents);
  if (!isWindows) {
    NodeFS.chmodSync(path, 0o755);
  }
}

function createProviderShims(shimDirectory: string, isWindows: boolean): void {
  NodeFS.writeFileSync(NodePath.join(shimDirectory, "codex-fixture.mjs"), codexFixtureSource);

  if (isWindows) {
    NodeFS.writeFileSync(
      NodePath.join(shimDirectory, "codex.cmd"),
      '@node "%~dp0\\codex-fixture.mjs" %*\r\n',
    );
    for (const provider of ["claude", "cursor-agent", "grok", "opencode"]) {
      NodeFS.writeFileSync(
        NodePath.join(shimDirectory, `${provider}.cmd`),
        `@echo ${provider} 99.0.0-fixture\r\n`,
      );
    }
    return;
  }

  writeExecutable(
    NodePath.join(shimDirectory, "codex"),
    '#!/bin/sh\nexec node "$(dirname "$0")/codex-fixture.mjs" "$@"\n',
    false,
  );
  for (const provider of ["claude", "cursor-agent", "grok", "opencode"]) {
    writeExecutable(
      NodePath.join(shimDirectory, provider),
      `#!/bin/sh\nprintf '%s\\n' '${provider} 99.0.0-fixture'\n`,
      false,
    );
  }
}

function writeProviderSettings(stateRoot: string, shimDirectory: string, isWindows: boolean): void {
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
          claudeAgent: { enabled: false, binaryPath: executablePath("claude") },
          cursor: { enabled: false, binaryPath: executablePath("cursor-agent") },
          grok: { enabled: false, binaryPath: executablePath("grok") },
          opencode: { enabled: false, binaryPath: executablePath("opencode") },
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
  if (NodeFS.existsSync(NodePath.join(projectPath, ".git"))) return;
  NodeFS.mkdirSync(projectPath, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(projectPath, "README.md"),
    "# T4Code packaged desktop UI fixture\n",
  );
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

  NodeFS.mkdirSync(stateRoot, { recursive: true });
  NodeFS.mkdirSync(shimDirectory, { recursive: true });
  NodeFS.mkdirSync(artifactDirectory, { recursive: true });
  initializeGitProject(projectPath);
  // oxlint-disable-next-line t4code/no-global-process-runtime -- The standalone WDIO fixture injects the detected host into its adapters.
  const hostPlatform = environment.T4CODE_E2E_PLATFORM ?? process.platform;
  const isWindows = hostPlatform === "win" || hostPlatform === "win32";
  createProviderShims(shimDirectory, isWindows);
  writeProviderSettings(stateRoot, shimDirectory, isWindows);

  environment.T4CODE_E2E_RUN_ROOT = runRoot;
  environment.T4CODE_E2E_ARTIFACT_DIR = artifactDirectory;
  environment.T4CODE_E2E_PROJECT_PATH = projectPath;
  environment.T4CODE_E2E_SHIM_DIRECTORY = shimDirectory;
  environment.T4CODE_HOME = stateRoot;
  environment.PATH = `${shimDirectory}${NodePath.delimiter}${environment.PATH ?? ""}`;
  environment.RUST_LOG ??= "t4code=debug";

  return { runRoot, stateRoot, projectPath, shimDirectory, artifactDirectory };
}

export function archiveAndCleanupDesktopUiTestContext(
  context: DesktopUiTestContext,
  removeDirectory: DesktopUiDirectoryRemover = NodeFS.rmSync,
): void {
  const archivedState = NodePath.join(context.artifactDirectory, "state");
  if (NodeFS.existsSync(context.stateRoot)) {
    NodeFS.cpSync(context.stateRoot, archivedState, { recursive: true, force: true });
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
