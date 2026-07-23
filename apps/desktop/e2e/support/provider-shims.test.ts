// @effect-diagnostics nodeBuiltinImport:off - Native fixture tests execute generated host shims.
// @effect-diagnostics globalDate:off - Native protocol polling runs outside an Effect runtime.
// @effect-diagnostics globalTimers:off - Native protocol polling runs outside an Effect runtime.
// @effect-diagnostics globalFetch:off - The test probes its generated local OpenCode HTTP server.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readProviderInputLog } from "./provider-input-log.ts";
import {
  archiveAndCleanupDesktopUiTestContext,
  prepareDesktopUiTestContext,
  type DesktopUiTestContext,
} from "./test-project.ts";

interface PreparedProviderFixture {
  readonly context: DesktopUiTestContext;
  readonly environment: NodeJS.ProcessEnv;
}

const preparedFixtures: PreparedProviderFixture[] = [];

function prepareProviderFixture(): PreparedProviderFixture {
  // oxlint-disable-next-line t4code/no-global-process-runtime -- These integration tests execute shims for the current native host.
  const hostPlatform = NodeOS.platform();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    T4CODE_E2E_PLATFORM:
      hostPlatform === "win32" ? "win" : hostPlatform === "darwin" ? "mac" : "linux",
  };
  const context = prepareDesktopUiTestContext(environment);
  const fixture = { context, environment };
  preparedFixtures.push(fixture);
  return fixture;
}

function fixtureSourcePath(context: DesktopUiTestContext, name: string): string {
  return NodePath.join(context.shimDirectory, `${name}-fixture.mjs`);
}

function exchangeJsonLines(
  fixture: PreparedProviderFixture,
  name: string,
  messages: ReadonlyArray<unknown>,
): Array<Record<string, unknown>> {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [fixtureSourcePath(fixture.context, name)],
    {
      encoding: "utf8",
      env: fixture.environment,
      input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    },
  );
  if (result.status !== 0) {
    throw new Error(`${name} fixture failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function responseWithId(
  messages: ReadonlyArray<Record<string, unknown>>,
  id: number,
): Record<string, unknown> {
  const response = messages.find((message) => message.id === id);
  if (!response) {
    throw new Error(`Fixture response ${id} was not emitted: ${JSON.stringify(messages)}`);
  }
  return response;
}

function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = NodeNet.createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      reservation.close((error) => {
        if (error) {
          reject(error);
        } else if (port === null) {
          reject(new Error("The OpenCode fixture did not reserve a TCP port."));
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForHealthyEndpoint(endpoint: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/global/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`OpenCode fixture did not become healthy: ${String(lastError)}`);
}

async function readServerSentEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  eventType: string,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5_000;
  let buffer = "";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Timed out waiting for SSE event ${eventType}.`)),
          remaining,
        );
      }),
    ]);
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    for (const frame of buffer.split("\n\n")) {
      const data = frame
        .split(/\r?\n/u)
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (!data) {
        continue;
      }
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event.type === eventType) {
        return event;
      }
    }
    const lastFrameBoundary = buffer.lastIndexOf("\n\n");
    if (lastFrameBoundary >= 0) {
      buffer = buffer.slice(lastFrameBoundary + 2);
    }
  }
  throw new Error(`SSE event ${eventType} was not emitted. Buffered data: ${buffer}`);
}

async function stopFixtureProcess(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Fixture process did not stop after SIGTERM.")), 5_000);
    }),
  ]);
}

afterEach(() => {
  for (const fixture of preparedFixtures.splice(0)) {
    archiveAndCleanupDesktopUiTestContext(fixture.context);
  }
});

describe("generated provider shims", () => {
  it("speaks Codex app-server inventory and turn protocols", () => {
    const fixture = prepareProviderFixture();
    const responses = exchangeJsonLines(fixture, "codex", [
      { id: 1, method: "initialize" },
      { id: 2, method: "skills/list", params: { cwds: [fixture.context.projectPath] } },
      {
        id: 3,
        method: "turn/start",
        params: { input: [{ type: "text", text: "$refactor" }] },
      },
    ]);

    expect(responseWithId(responses, 2)).toMatchObject({
      result: {
        data: [
          {
            cwd: fixture.context.projectPath,
            skills: [{ name: "refactor", enabled: true }],
          },
        ],
      },
    });
    expect(responses).toContainEqual(
      expect.objectContaining({
        method: "turn/completed",
        params: expect.objectContaining({ turn: expect.objectContaining({ status: "completed" }) }),
      }),
    );
    expect(readProviderInputLog(fixture.context.providerInputLogPath)).toMatchObject([
      { provider: "codex", prompt: "$refactor" },
    ]);
  });

  it("speaks Claude control, skill reload, stream, and result protocols", () => {
    const fixture = prepareProviderFixture();
    const responses = exchangeJsonLines(fixture, "claude", [
      {
        type: "control_request",
        request_id: "initialize",
        request: { subtype: "initialize" },
      },
      {
        type: "control_request",
        request_id: "skills",
        request: { subtype: "reload_skills" },
      },
      {
        type: "user",
        session_id: "claude-fixture",
        message: { content: [{ type: "text", text: "/compact" }] },
      },
    ]);

    expect(responses).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "initialize",
          response: expect.objectContaining({
            commands: [expect.objectContaining({ name: "compact" })],
          }),
        }),
      }),
    );
    expect(responses).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "skills",
          response: { skills: [expect.objectContaining({ name: "docs" })] },
        }),
      }),
    );
    expect(responses).toContainEqual(expect.objectContaining({ type: "stream_event" }));
    expect(responses).toContainEqual(
      expect.objectContaining({ type: "result", subtype: "success", is_error: false }),
    );
    expect(readProviderInputLog(fixture.context.providerInputLogPath)).toMatchObject([
      { provider: "claudeAgent", prompt: "/compact" },
    ]);
  });

  it("speaks Cursor ACP session and prompt protocols", () => {
    const fixture = prepareProviderFixture();
    const responses = exchangeJsonLines(fixture, "cursor-agent", [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "authenticate" },
      { jsonrpc: "2.0", id: 3, method: "session/new", params: {} },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: { prompt: [{ type: "text", text: "/review" }] },
      },
    ]);

    expect(responseWithId(responses, 3)).toMatchObject({
      jsonrpc: "2.0",
      result: {
        sessionId: "t4code-ui-cursor-session",
        modes: { currentModeId: "ask" },
      },
    });
    expect(responseWithId(responses, 4)).toMatchObject({
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
    expect(readProviderInputLog(fixture.context.providerInputLogPath)).toMatchObject([
      { provider: "cursor", prompt: "/review" },
    ]);
  });

  it("serves OpenCode inventory, session, prompt, and SSE protocols", async () => {
    const fixture = prepareProviderFixture();
    const port = await reserveLocalPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        fixtureSourcePath(fixture.context, "opencode"),
        "serve",
        "--hostname=127.0.0.1",
        `--port=${port}`,
      ],
      {
        env: fixture.environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const abort = new AbortController();

    try {
      await waitForHealthyEndpoint(endpoint);
      expect(await (await fetch(`${endpoint}/provider`)).json()).toMatchObject({
        connected: ["openai"],
      });
      expect(await (await fetch(`${endpoint}/agent`)).json()).toEqual([
        expect.objectContaining({ name: "writer", mode: "primary" }),
        expect.objectContaining({ name: "reviewer", mode: "subagent" }),
        expect.objectContaining({ name: "operator", mode: "all" }),
        expect.objectContaining({ name: "secret", mode: "subagent", hidden: true }),
      ]);
      expect(await (await fetch(`${endpoint}/command`)).json()).toEqual([
        expect.objectContaining({ name: "init" }),
      ]);

      const eventResponse = await fetch(`${endpoint}/event`, { signal: abort.signal });
      expect(eventResponse.headers.get("content-type")).toContain("text/event-stream");
      const reader = eventResponse.body?.getReader();
      if (!reader) {
        throw new Error("OpenCode fixture did not return an SSE response body.");
      }

      expect(
        await (
          await fetch(`${endpoint}/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).json(),
      ).toEqual({ id: "t4code-ui-opencode-session" });
      await fetch(`${endpoint}/session/t4code-ui-opencode-session/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "@reviewer" }] }),
      });

      expect(await readServerSentEvent(reader, "session.status")).toMatchObject({
        properties: {
          sessionID: "t4code-ui-opencode-session",
          status: { type: "idle" },
        },
      });
      expect(readProviderInputLog(fixture.context.providerInputLogPath)).toMatchObject([
        { provider: "opencode", prompt: "@reviewer" },
      ]);
      await reader.cancel();
    } finally {
      abort.abort();
      await stopFixtureProcess(child);
    }
  });

  it("speaks Grok ACP session and prompt protocols", () => {
    const fixture = prepareProviderFixture();
    const responses = exchangeJsonLines(fixture, "grok", [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "authenticate" },
      { jsonrpc: "2.0", id: 3, method: "session/create", params: {} },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: { prompt: [{ type: "text", text: "/skills" }] },
      },
    ]);

    expect(responseWithId(responses, 3)).toMatchObject({
      jsonrpc: "2.0",
      result: {
        sessionId: "t4code-ui-grok-session",
        modes: { currentModeId: "code" },
      },
    });
    expect(responseWithId(responses, 4)).toMatchObject({
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
    expect(readProviderInputLog(fixture.context.providerInputLogPath)).toMatchObject([
      { provider: "grok", prompt: "/skills" },
    ]);
  });
});
