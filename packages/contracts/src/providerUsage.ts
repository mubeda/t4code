import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const ServerProviderUsageProvider = Schema.Literals(["claude", "codex"]);
export type ServerProviderUsageProvider = typeof ServerProviderUsageProvider.Type;

export const ServerProviderUsageStatus = Schema.Literals([
  "idle",
  "fetching",
  "ok",
  "error",
  "unavailable",
]);
export type ServerProviderUsageStatus = typeof ServerProviderUsageStatus.Type;

export const ServerProviderUsageWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowMinutes: NonNegativeInt,
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
  resetDescription: Schema.NullOr(Schema.String),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderUsageResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  totalEarnedCount: Schema.NullOr(NonNegativeInt),
  nextExpiresAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type ServerProviderUsageResetCredits = typeof ServerProviderUsageResetCredits.Type;

export const ServerProviderUsageSnapshot = Schema.Struct({
  provider: ServerProviderUsageProvider,
  status: ServerProviderUsageStatus,
  session: Schema.NullOr(ServerProviderUsageWindow),
  weekly: Schema.NullOr(ServerProviderUsageWindow),
  fableWeekly: Schema.NullOr(ServerProviderUsageWindow).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  planType: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  rateLimitResetCredits: Schema.NullOr(ServerProviderUsageResetCredits).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  updatedAt: Schema.DateTimeUtc,
  error: Schema.NullOr(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.String),
});
export type ServerProviderUsageSnapshot = typeof ServerProviderUsageSnapshot.Type;

export const ServerProviderUsageResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  isFetching: Schema.Boolean,
  providers: Schema.Array(ServerProviderUsageSnapshot),
});
export type ServerProviderUsageResult = typeof ServerProviderUsageResult.Type;

export const ServerProviderUsageRefreshInput = Schema.Struct({
  providers: Schema.optional(Schema.Array(ServerProviderUsageProvider)),
});
export type ServerProviderUsageRefreshInput = typeof ServerProviderUsageRefreshInput.Type;

export const CodexRateLimitResetOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type CodexRateLimitResetOutcome = typeof CodexRateLimitResetOutcome.Type;

export const ConsumeCodexRateLimitResetInput = Schema.Struct({ requestId: Schema.String });
export type ConsumeCodexRateLimitResetInput = typeof ConsumeCodexRateLimitResetInput.Type;

export const ConsumeCodexRateLimitResetResult = Schema.Struct({
  outcome: CodexRateLimitResetOutcome,
  usage: ServerProviderUsageResult,
});
export type ConsumeCodexRateLimitResetResult = typeof ConsumeCodexRateLimitResetResult.Type;

export class ServerProviderUsageResetError extends Schema.TaggedErrorClass<ServerProviderUsageResetError>()(
  "ServerProviderUsageResetError",
  {
    message: Schema.String,
  },
) {}
