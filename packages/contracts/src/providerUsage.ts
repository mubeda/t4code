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

export const ServerProviderUsageSnapshot = Schema.Struct({
  provider: ServerProviderUsageProvider,
  status: ServerProviderUsageStatus,
  session: Schema.NullOr(ServerProviderUsageWindow),
  weekly: Schema.NullOr(ServerProviderUsageWindow),
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
