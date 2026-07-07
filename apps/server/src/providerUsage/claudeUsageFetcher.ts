// @effect-diagnostics nodeBuiltinImport:off - Usage discovery reads Claude Code's existing credentials file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderUsageSnapshot } from "@t3tools/contracts";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";

class ClaudeUsageDependencyError extends Data.TaggedError("ClaudeUsageDependencyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface ClaudeOAuthCredentials {
  readonly accessToken: string;
  readonly source: "credentials-file";
}

interface ClaudeOAuthUsageWindow {
  readonly utilization?: unknown;
  readonly used_percentage?: unknown;
  readonly resets_at?: unknown;
}

interface ClaudeOAuthUsageResponse {
  readonly five_hour?: ClaudeOAuthUsageWindow;
  readonly seven_day?: ClaudeOAuthUsageWindow;
}

interface FetchJsonResult {
  readonly ok: boolean;
  readonly status: number;
  readonly json: unknown;
}

interface FetchClaudeUsageDependencies {
  readonly now: DateTime.Utc;
  readonly readCredentials: Effect.Effect<string, ClaudeUsageDependencyError>;
  readonly fetchJson: (
    url: string,
    init: { readonly headers: Record<string, string> },
  ) => Effect.Effect<FetchJsonResult, ClaudeUsageDependencyError>;
}

function unavailableClaudeUsageSnapshot(
  now: DateTime.Utc,
  error = "Claude OAuth credentials were not found.",
): ServerProviderUsageSnapshot {
  return {
    provider: "claude",
    status: "unavailable",
    session: null,
    weekly: null,
    updatedAt: now,
    error,
    metadata: {},
  };
}

function errorClaudeUsageSnapshot(now: DateTime.Utc, error: string): ServerProviderUsageSnapshot {
  return {
    provider: "claude",
    status: "error",
    session: null,
    weekly: null,
    updatedAt: now,
    error,
    metadata: {},
  };
}

function parseResetTimestamp(value: unknown): DateTime.Utc | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return DateTime.makeUnsafe(value < 10_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return DateTime.makeUnsafe(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? DateTime.makeUnsafe(parsed) : null;
}

function mapOAuthWindow(
  raw: ClaudeOAuthUsageWindow | undefined,
  windowMinutes: number,
): ServerProviderUsageWindow | null {
  if (!raw) return null;
  const usedPercent =
    typeof raw.utilization === "number"
      ? raw.utilization
      : typeof raw.used_percentage === "number"
        ? raw.used_percentage
        : null;
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    resetsAt: parseResetTimestamp(raw.resets_at),
    resetDescription: null,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function parseClaudeOAuthCredentials(raw: string): ClaudeOAuthCredentials | null {
  try {
    const parsed = JSON.parse(raw) as {
      readonly claudeAiOauth?: {
        readonly accessToken?: unknown;
      };
    };
    const accessToken = parsed.claudeAiOauth?.accessToken;
    if (typeof accessToken !== "string" || accessToken.trim().length === 0) return null;
    return {
      accessToken,
      source: "credentials-file",
    };
  } catch {
    return null;
  }
}

export function mapClaudeOAuthUsageResponse(
  raw: ClaudeOAuthUsageResponse,
  now: DateTime.Utc,
): ServerProviderUsageSnapshot {
  const session = mapOAuthWindow(raw.five_hour, 300);
  const weekly = mapOAuthWindow(raw.seven_day, 10080);
  if (!session && !weekly) {
    return unavailableClaudeUsageSnapshot(now, "Claude did not report usage windows.");
  }
  return {
    provider: "claude",
    status: "ok",
    session,
    weekly,
    updatedAt: now,
    error: null,
    metadata: {
      source: "oauth",
      credentialSource: "credentials-file",
    },
  };
}

export function fetchClaudeUsageSnapshotWithDependencies(
  dependencies: FetchClaudeUsageDependencies,
): Effect.Effect<ServerProviderUsageSnapshot> {
  return Effect.gen(function* () {
    const credentialsRaw = yield* dependencies.readCredentials.pipe(
      Effect.orElseSucceed(() => null),
    );
    if (credentialsRaw === null) {
      return unavailableClaudeUsageSnapshot(dependencies.now);
    }

    const credentials = parseClaudeOAuthCredentials(credentialsRaw);
    if (!credentials) {
      return unavailableClaudeUsageSnapshot(dependencies.now);
    }

    const response = yield* dependencies
      .fetchJson(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
          "User-Agent": CLAUDE_CODE_USER_AGENT,
        },
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            ok: false,
            status: 0,
            json: { error: errorMessage(cause) },
          }),
        ),
      );
    if (!response.ok) {
      return errorClaudeUsageSnapshot(
        dependencies.now,
        response.status > 0
          ? `Claude usage request failed with HTTP ${response.status}.`
          : "Claude usage request failed.",
      );
    }
    return mapClaudeOAuthUsageResponse(response.json as ClaudeOAuthUsageResponse, dependencies.now);
  });
}

function resolveClaudeCredentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");
  return NodePath.join(configDir, ".credentials.json");
}

function fetchClaudeUsageFromEnvironment(now: DateTime.Utc) {
  return fetchClaudeUsageSnapshotWithDependencies({
    now,
    readCredentials: Effect.tryPromise({
      try: () => NodeFSP.readFile(resolveClaudeCredentialsPath(), "utf8"),
      catch: (cause) =>
        new ClaudeUsageDependencyError({
          message: errorMessage(cause),
          cause,
        }),
    }),
    fetchJson: (url, init) =>
      Effect.tryPromise({
        try: async () => {
          // @effect-diagnostics-next-line globalFetchInEffect:off - This is a small server boundary around Claude's usage endpoint.
          const response = await fetch(url, {
            headers: init.headers,
            signal: AbortSignal.timeout(10_000),
          });
          return {
            ok: response.ok,
            status: response.status,
            json: await response.json(),
          };
        },
        catch: (cause) =>
          new ClaudeUsageDependencyError({
            message: errorMessage(cause),
            cause,
          }),
      }),
  });
}

export const fetchClaudeUsageSnapshot = DateTime.now.pipe(
  Effect.flatMap((now) => fetchClaudeUsageFromEnvironment(now)),
);
