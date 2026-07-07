// @effect-diagnostics nodeBuiltinImport:off - Codex usage needs a short-lived Codex CLI app-server child process.
// @effect-diagnostics preferSchemaOverJson:off - Codex app-server uses newline-delimited JSON-RPC.
// @effect-diagnostics globalTimers:off - The child-process line reader owns a Node timeout around each RPC read.
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ServerProviderUsageSnapshot, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const CODEX_RPC_TIMEOUT_MS = 10_000;

class CodexUsageDependencyError extends Data.TaggedError("CodexUsageDependencyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface RpcRateWindow {
  readonly usedPercent?: unknown;
  readonly windowDurationMins?: unknown;
  readonly resetsAt?: unknown;
}

interface CodexRateLimitsResponse {
  readonly rateLimits?: {
    readonly primary?: RpcRateWindow;
    readonly secondary?: RpcRateWindow;
  };
}

interface CodexAppServerTransport {
  readonly write: (line: string) => Effect.Effect<void, CodexUsageDependencyError>;
  readonly readLine: Effect.Effect<string, CodexUsageDependencyError>;
  readonly close: Effect.Effect<void, never>;
}

interface FetchCodexUsageDependencies {
  readonly now: DateTime.Utc;
  readonly authExists: Effect.Effect<boolean, CodexUsageDependencyError>;
  readonly startAppServer: () => Effect.Effect<CodexAppServerTransport, CodexUsageDependencyError>;
}

function parseResetTimestamp(value: unknown): DateTime.Utc | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return DateTime.makeUnsafe(value < 10_000_000_000 ? value * 1_000 : value);
}

function mapRateWindow(
  window: RpcRateWindow | undefined,
  expectedWindowMinutes: number,
): ServerProviderUsageWindow | null {
  if (!window) return null;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    windowMinutes: expectedWindowMinutes,
    resetsAt: parseResetTimestamp(window.resetsAt),
    resetDescription: null,
  };
}

export function mapCodexRateLimitsResponse(
  raw: CodexRateLimitsResponse,
  now: DateTime.Utc,
): ServerProviderUsageSnapshot {
  const session = mapRateWindow(raw.rateLimits?.primary, 300);
  const weekly = mapRateWindow(raw.rateLimits?.secondary, 10080);
  if (!session && !weekly) {
    return {
      provider: "codex",
      status: "unavailable",
      session: null,
      weekly: null,
      updatedAt: now,
      error: "Codex did not report rate-limit windows.",
      metadata: {},
    };
  }

  return {
    provider: "codex",
    status: "ok",
    session,
    weekly,
    updatedAt: now,
    error: null,
    metadata: {
      source: "app-server",
    },
  };
}

function unavailableCodexUsageSnapshot(
  now: DateTime.Utc,
  error = "Codex not signed in.",
): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    status: "unavailable",
    session: null,
    weekly: null,
    updatedAt: now,
    error,
    metadata: {},
  };
}

function errorCodexUsageSnapshot(now: DateTime.Utc, error: string): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    status: "error",
    session: null,
    weekly: null,
    updatedAt: now,
    error,
    metadata: {},
  };
}

function buildRpcMessage(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`;
}

function buildRpcNotification(method: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`;
}

function parseRpcResponse(line: string): {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
} | null {
  try {
    const parsed = JSON.parse(line) as {
      readonly id?: unknown;
      readonly result?: unknown;
      readonly error?: { readonly message?: unknown };
    };
    return parsed;
  } catch {
    return null;
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function fetchCodexUsageSnapshotWithDependencies(
  dependencies: FetchCodexUsageDependencies,
): Effect.Effect<ServerProviderUsageSnapshot> {
  return Effect.gen(function* () {
    const authExists = yield* dependencies.authExists.pipe(Effect.orElseSucceed(() => false));
    if (!authExists) {
      return unavailableCodexUsageSnapshot(dependencies.now);
    }

    return yield* Effect.acquireUseRelease(
      dependencies.startAppServer(),
      (transport) =>
        Effect.gen(function* () {
          const initializeId = 1;
          const rateLimitsId = 2;
          yield* transport.write(
            buildRpcMessage(initializeId, "initialize", {
              clientInfo: {
                name: "t3code",
                title: "T4Code",
                version: "0.1.0",
              },
              capabilities: {
                experimentalApi: true,
              },
            }),
          );

          while (true) {
            const message = parseRpcResponse(yield* transport.readLine);
            if (!message || message.id !== initializeId) continue;
            if (message.error) {
              return errorCodexUsageSnapshot(
                dependencies.now,
                typeof message.error.message === "string"
                  ? message.error.message
                  : "Codex app-server initialize failed.",
              );
            }
            break;
          }

          yield* transport.write(buildRpcNotification("initialized"));
          yield* transport.write(buildRpcMessage(rateLimitsId, "account/rateLimits/read"));

          while (true) {
            const message = parseRpcResponse(yield* transport.readLine);
            if (!message || message.id !== rateLimitsId) continue;
            if (message.error) {
              return errorCodexUsageSnapshot(
                dependencies.now,
                typeof message.error.message === "string"
                  ? message.error.message
                  : "Codex app-server rate-limit read failed.",
              );
            }
            return mapCodexRateLimitsResponse(
              message.result as CodexRateLimitsResponse,
              dependencies.now,
            );
          }
        }),
      (transport) => transport.close,
    ).pipe(
      Effect.catch((cause) =>
        Effect.succeed(errorCodexUsageSnapshot(dependencies.now, describeError(cause))),
      ),
    );
  });
}

function resolveCodexHomePath(): string {
  return process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
}

function codexAuthExists(): boolean {
  return NodeFS.existsSync(NodePath.join(resolveCodexHomePath(), "auth.json"));
}

function startNodeCodexAppServer(): Effect.Effect<
  CodexAppServerTransport,
  CodexUsageDependencyError
> {
  return Effect.try({
    try: () => {
      const codexCommand = process.env.CODEX_BIN ?? "codex";
      const codexArgs = ["-s", "read-only", "-a", "untrusted", "app-server"];
      const command =
        process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : codexCommand;
      const args =
        process.platform === "win32" ? ["/d", "/c", codexCommand, ...codexArgs] : codexArgs;
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      return makeNodeTransport(child);
    },
    catch: (cause) =>
      new CodexUsageDependencyError({
        message: describeError(cause),
        cause,
      }),
  });
}

function makeNodeTransport(child: ChildProcessWithoutNullStreams): CodexAppServerTransport {
  let buffer = "";
  let stderr = "";
  const lines: string[] = [];
  const waiters: Array<{
    readonly resolve: (line: string) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }> = [];
  let closedError: Error | null = null;

  const rejectWaiters = (error: Error) => {
    closedError = error;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };

  const pushLine = (line: string) => {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(line);
      return;
    }
    lines.push(line);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) pushLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
  });
  child.on("error", (error) => rejectWaiters(error));
  child.on("close", () =>
    rejectWaiters(new Error(stderr.trim() || "Codex app-server exited before replying.")),
  );

  return {
    write: (line) =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            child.stdin.write(line, (error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
        catch: (cause) =>
          new CodexUsageDependencyError({
            message: describeError(cause),
            cause,
          }),
      }),
    readLine: Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          const line = lines.shift();
          if (line) {
            resolve(line);
            return;
          }
          if (closedError) {
            reject(closedError);
            return;
          }
          const timeout = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Codex app-server RPC timeout."));
          }, CODEX_RPC_TIMEOUT_MS);
          waiters.push({ resolve, reject, timeout });
        }),
      catch: (cause) =>
        new CodexUsageDependencyError({
          message: describeError(cause),
          cause,
        }),
    }),
    close: Effect.sync(() => {
      if (!child.killed) child.kill();
    }),
  };
}

function fetchCodexUsageFromEnvironment(now: DateTime.Utc) {
  return fetchCodexUsageSnapshotWithDependencies({
    now,
    authExists: Effect.sync(codexAuthExists),
    startAppServer: startNodeCodexAppServer,
  });
}

export const fetchCodexUsageSnapshot = DateTime.now.pipe(
  Effect.flatMap((now) => fetchCodexUsageFromEnvironment(now)),
);
