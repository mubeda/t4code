# Status Bar Implementation Plan

> Status: completed and archival. This plan preserves its original TypeScript
> server paths and commands. Current backend behavior lives in the native Rust
> server; use [Current Scripts](../../reference/scripts.md) for supported
> commands.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved T4Code-focused Orca-style status bar with Claude/Codex usage, refresh, and a resource manager backed by existing process diagnostics.

**Architecture:** Add schema-only provider usage contracts, a server-side provider usage service exposed through WebSocket RPC, and focused React status-bar components mounted in the authenticated app shell. Reuse existing diagnostics and terminal metadata for Resource Manager instead of duplicating process monitoring.

**Tech Stack:** TypeScript, Effect Schema/RPC, Effect services/layers, React, Effect Atom runtime, Vitest, Playwright/Chrome verification.

## Global Constraints

- Keep `packages/contracts` schema-only.
- Do not edit vendored `.repos/` content.
- Use TDD: every production behavior gets a failing test first.
- Resource metrics are T4 server process descendants, not whole-machine totals; UI copy must say that.
- Run `vp test`, fix failures caused by this change, then run `vp check` and `vp run typecheck`.
- Verify the running UI with Playwright/Chrome after implementation.

---

## File Structure

- Create `packages/contracts/src/providerUsage.ts`: shared provider usage DTO schemas.
- Modify `packages/contracts/src/index.ts`: export provider usage contracts.
- Modify `packages/contracts/src/rpc.ts`: add `server.getProviderUsage` and `server.refreshProviderUsage` RPCs.
- Test `packages/contracts/src/providerUsage.test.ts`: decode/encode provider usage payloads.
- Create `apps/server/src/providerUsage/ProviderUsageService.ts`: Effect service with in-memory snapshots, refresh policy, and provider fetcher injection.
- Create `apps/server/src/providerUsage/codexUsageFetcher.ts`: Codex rate-limit RPC mapping helpers.
- Create `apps/server/src/providerUsage/claudeUsageFetcher.ts`: first-pass Claude unavailable/OAuth mapping helpers.
- Test `apps/server/src/providerUsage/ProviderUsageService.test.ts`: stale/debounce/single-flight/provider snapshot behavior.
- Test `apps/server/src/providerUsage/codexUsageFetcher.test.ts`: Codex primary/secondary mapping and error cases.
- Modify `apps/server/src/server.ts`: provide the usage service layer.
- Modify `apps/server/src/ws.ts`: wire usage RPC handlers and auth scopes.
- Modify `packages/client-runtime/src/state/server.ts`: expose usage query/refresh atoms.
- Create `apps/web/src/components/status-bar/statusBarFormat.ts`: pure formatting and color helpers.
- Create `apps/web/src/components/status-bar/statusBarPresentation.ts`: pure view-model builders.
- Test `apps/web/src/components/status-bar/statusBarFormat.test.ts`: labels, percentages, colors, memory/CPU formats.
- Test `apps/web/src/components/status-bar/statusBarPresentation.test.ts`: provider/resource view models.
- Create `apps/web/src/components/status-bar/ProviderUsageSegment.tsx`: compact provider trigger.
- Create `apps/web/src/components/status-bar/ProviderUsagePopover.tsx`: provider detail popover.
- Create `apps/web/src/components/status-bar/ResourceUsageSegment.tsx`: resource trigger and popover.
- Create `apps/web/src/components/status-bar/AppStatusBar.tsx`: bottom bar shell, refresh, responsive compact state.
- Modify `apps/web/src/routes/__root.tsx` or `apps/web/src/components/AppSidebarLayout.tsx`: mount status bar only for authenticated app shell.
- Test `apps/web/src/components/status-bar/AppStatusBar.test.tsx`: renders providers/resources and triggers refresh.
- Test `apps/web/src/routes/__root.test.tsx`: authenticated shell includes status bar; pair/auth pages do not.

---

### Task 1: Provider Usage Contracts

**Files:**

- Create: `packages/contracts/src/providerUsage.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Test: `packages/contracts/src/providerUsage.test.ts`

**Interfaces:**

- Produces: `ServerProviderUsageProvider`, `ServerProviderUsageStatus`, `ServerProviderUsageWindow`, `ServerProviderUsageSnapshot`, `ServerProviderUsageResult`, `ServerProviderUsageRefreshInput`.
- Produces RPCs: `WsServerGetProviderUsageRpc`, `WsServerRefreshProviderUsageRpc`.

- [ ] **Step 1: Write failing contract tests**

Add tests that decode a complete provider usage result with Claude and Codex windows, and reject an unknown provider.

Run: `vp test packages/contracts/src/providerUsage.test.ts`
Expected: FAIL because `providerUsage.ts` does not exist.

- [ ] **Step 2: Add schemas**

Implement provider usage schemas with Effect Schema:

```ts
export const ServerProviderUsageProvider = Schema.Literals(["claude", "codex"]);
export const ServerProviderUsageStatus = Schema.Literals([
  "idle",
  "fetching",
  "ok",
  "error",
  "unavailable",
]);
export const ServerProviderUsageWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowMinutes: NonNegativeInt,
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
  resetDescription: Schema.NullOr(Schema.String),
});
export const ServerProviderUsageSnapshot = Schema.Struct({
  provider: ServerProviderUsageProvider,
  status: ServerProviderUsageStatus,
  session: Schema.NullOr(ServerProviderUsageWindow),
  weekly: Schema.NullOr(ServerProviderUsageWindow),
  updatedAt: Schema.DateTimeUtc,
  error: Schema.NullOr(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.String),
});
export const ServerProviderUsageResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  isFetching: Schema.Boolean,
  providers: Schema.Array(ServerProviderUsageSnapshot),
});
export const ServerProviderUsageRefreshInput = Schema.Struct({
  providers: Schema.optional(Schema.Array(ServerProviderUsageProvider)),
});
```

- [ ] **Step 3: Export and wire RPCs**

Export `providerUsage.ts` from `packages/contracts/src/index.ts`. Add WS methods:

```ts
serverGetProviderUsage: "server.getProviderUsage",
serverRefreshProviderUsage: "server.refreshProviderUsage",
```

Create RPCs:

```ts
export const WsServerGetProviderUsageRpc = Rpc.make(WS_METHODS.serverGetProviderUsage, {
  payload: Schema.Struct({}),
  success: ServerProviderUsageResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerRefreshProviderUsageRpc = Rpc.make(WS_METHODS.serverRefreshProviderUsage, {
  payload: ServerProviderUsageRefreshInput,
  success: ServerProviderUsageResult,
  error: EnvironmentAuthorizationError,
});
```

Add both RPCs to `WsRpcGroup`.

- [ ] **Step 4: Verify contracts**

Run: `vp test packages/contracts/src/providerUsage.test.ts packages/contracts/src/rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage the task files and commit with: `feat: add provider usage contracts`.

---

### Task 2: Server Provider Usage Service

**Files:**

- Create: `apps/server/src/providerUsage/ProviderUsageService.ts`
- Create: `apps/server/src/providerUsage/codexUsageFetcher.ts`
- Create: `apps/server/src/providerUsage/claudeUsageFetcher.ts`
- Test: `apps/server/src/providerUsage/ProviderUsageService.test.ts`
- Test: `apps/server/src/providerUsage/codexUsageFetcher.test.ts`

**Interfaces:**

- Consumes: provider usage contracts from Task 1.
- Produces service tag `ProviderUsageService` with:
  - `read: Effect.Effect<ServerProviderUsageResult>`
  - `refresh: (input: ServerProviderUsageRefreshInput) => Effect.Effect<ServerProviderUsageResult>`

- [ ] **Step 1: Write failing service tests**

Cover:

- initial read returns unavailable Claude/Codex snapshots.
- refresh is single-flight when called concurrently.
- a provider fetch error becomes `status: "error"` and preserves the message.
- stale snapshots older than 30 minutes become unavailable on read.

Run: `vp test apps/server/src/providerUsage/ProviderUsageService.test.ts`
Expected: FAIL because service module does not exist.

- [ ] **Step 2: Implement service shell**

Use an Effect `Context.Service` with injected fetchers:

```ts
export interface ProviderUsageFetcher {
  readonly provider: ServerProviderUsageProvider;
  readonly fetch: Effect.Effect<ServerProviderUsageSnapshot>;
}
```

Keep internal state in `Ref`:

- snapshots by provider.
- `isFetching`.
- `lastRefreshStartedAtMs`.
- in-flight refresh fiber/promise equivalent.

Use constants:

- `MIN_MANUAL_REFRESH_MS = 30_000`
- `STALE_THRESHOLD_MS = 30 * 60_000`

- [ ] **Step 3: Write failing Codex mapper tests**

Test mapping:

- `primary` -> session window.
- `secondary` -> weekly window.
- Unix seconds reset timestamps become `DateTime.Utc`.
- missing windows returns unavailable.

Run: `vp test apps/server/src/providerUsage/codexUsageFetcher.test.ts`
Expected: FAIL because mapper does not exist.

- [ ] **Step 4: Implement Codex mapper/fetcher helpers**

Implement a pure `mapCodexRateLimitsResponse(raw, now)` function first. The process-spawn fetcher can call this mapper, but tests should focus on the mapper.

- [ ] **Step 5: Implement Claude first-pass helpers**

Implement a pure helper that returns an unavailable Claude snapshot when credentials are missing. If OAuth response mapping is added, keep it isolated in a pure mapper and test it before using it.

- [ ] **Step 6: Verify service and mappers**

Run: `vp test apps/server/src/providerUsage/ProviderUsageService.test.ts apps/server/src/providerUsage/codexUsageFetcher.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

Commit with: `feat: add provider usage service`.

---

### Task 3: Wire Server RPC

**Files:**

- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/ws.ts`
- Test: `apps/server/src/server.test.ts`

**Interfaces:**

- Consumes: `ProviderUsageService` from Task 2.
- Produces live RPC handling for `server.getProviderUsage` and `server.refreshProviderUsage`.

- [ ] **Step 1: Write failing RPC wiring test**

Add server RPC tests asserting:

- `server.getProviderUsage` calls the mocked service `read`.
- `server.refreshProviderUsage` calls mocked service `refresh`.

Run: `vp test apps/server/src/server.test.ts`
Expected: FAIL because RPC methods are not wired.

- [ ] **Step 2: Wire auth scopes and handlers**

In `apps/server/src/ws.ts`:

- add both methods to `AUTH_SCOPE_BY_WS_METHOD`.
- yield `ProviderUsageService`.
- add handlers next to process diagnostics handlers.
- mark instrumentation disabled only if the request is high-frequency; otherwise keep tracing enabled.

- [ ] **Step 3: Provide service layer**

In `apps/server/src/server.ts`, merge `ProviderUsageService.layer` into the server app layer near diagnostics services.

- [ ] **Step 4: Verify RPC wiring**

Run: `vp test apps/server/src/server.test.ts packages/contracts/src/rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit with: `feat: expose provider usage rpc`.

---

### Task 4: Client State and Pure Presentation

**Files:**

- Modify: `packages/client-runtime/src/state/server.ts`
- Create: `apps/web/src/components/status-bar/statusBarFormat.ts`
- Create: `apps/web/src/components/status-bar/statusBarPresentation.ts`
- Test: `apps/web/src/components/status-bar/statusBarFormat.test.ts`
- Test: `apps/web/src/components/status-bar/statusBarPresentation.test.ts`

**Interfaces:**

- Consumes: provider usage RPCs and existing process diagnostics/resource history contracts.
- Produces:
  - `serverEnvironment.providerUsage`
  - `serverEnvironment.refreshProviderUsage`
  - `formatProviderRemainingLabel(snapshot)`
  - `formatStatusBarBytes(bytes)`
  - `buildProviderUsageViewModel(snapshot)`
  - `buildResourceSummaryViewModel(processDiagnostics, terminalSessions)`

- [ ] **Step 1: Write failing formatting tests**

Cover:

- `usedPercent: 11` displays `89%`.
- `windowMinutes: 300` displays `5h`.
- `windowMinutes: 10080` displays `wk`.
- memory formats bytes as `736.3 MB` style.
- CPU formats one decimal percent.

Run: `vp test apps/web/src/components/status-bar/statusBarFormat.test.ts`
Expected: FAIL because helpers do not exist.

- [ ] **Step 2: Implement format helpers**

Implement small pure functions only; no React.

- [ ] **Step 3: Write failing presentation tests**

Cover:

- fetching snapshot returns fetching view model.
- unavailable snapshot returns `--`.
- resource summary includes child-process memory/CPU and terminal count.
- process rows sort by current memory or CPU time as selected.

Run: `vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts`
Expected: FAIL until presentation helpers exist.

- [ ] **Step 4: Implement presentation helpers**

Keep React-independent transformation logic in `statusBarPresentation.ts`.

- [ ] **Step 5: Add client atom families**

Extend `createServerEnvironmentAtoms`:

```ts
providerUsage: createEnvironmentRpcQueryAtomFamily(runtime, {
  label: "environment-data:server:provider-usage",
  tag: WS_METHODS.serverGetProviderUsage,
}),
refreshProviderUsage: createEnvironmentRpcCommand(runtime, {
  label: "environment-data:server:refresh-provider-usage",
  tag: WS_METHODS.serverRefreshProviderUsage,
}),
```

- [ ] **Step 6: Verify pure client work**

Run: `vp test apps/web/src/components/status-bar/statusBarFormat.test.ts apps/web/src/components/status-bar/statusBarPresentation.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

Commit with: `feat: add status bar client presentation`.

---

### Task 5: Status Bar React UI

**Files:**

- Create: `apps/web/src/components/status-bar/ProviderUsageSegment.tsx`
- Create: `apps/web/src/components/status-bar/ProviderUsagePopover.tsx`
- Create: `apps/web/src/components/status-bar/ResourceUsageSegment.tsx`
- Create: `apps/web/src/components/status-bar/AppStatusBar.tsx`
- Test: `apps/web/src/components/status-bar/AppStatusBar.test.tsx`

**Interfaces:**

- Consumes: presentation helpers from Task 4.
- Consumes: `useEnvironmentQuery`, `useAtomCommand`, `serverEnvironment`, `usePrimaryEnvironment`, terminal metadata hooks.
- Produces: `AppStatusBar` component.

- [ ] **Step 1: Write failing component tests**

Test:

- renders Claude and Codex labels from mocked usage query.
- clicking refresh invokes `refreshProviderUsage`.
- resource segment displays memory and terminal count.
- provider popover opens and shows reset/updated details.

Run: `vp test apps/web/src/components/status-bar/AppStatusBar.test.tsx`
Expected: FAIL because component does not exist.

- [ ] **Step 2: Implement provider segment and popover**

Use existing `Tooltip`, `Popover`, `Button`, `Progress`-like custom tiny bar, and lucide icons. Do not add new UI dependencies.

- [ ] **Step 3: Implement resource segment and popover**

Use:

- `serverEnvironment.processDiagnostics` for closed summary.
- `serverEnvironment.processResourceHistory` only when the popover is open.
- terminal metadata query for terminal count and terminal rows.
- `serverEnvironment.signalProcess` for per-process signal actions.

- [ ] **Step 4: Implement AppStatusBar**

Use `ResizeObserver` for compact/icon-only behavior:

- compact under `900px`.
- icon-only under `500px`.

Refresh button calls `refreshProviderUsage({ providers: ["claude", "codex"] })` and refreshes the usage query.

- [ ] **Step 5: Verify component tests**

Run: `vp test apps/web/src/components/status-bar/AppStatusBar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit with: `feat: add app status bar ui`.

---

### Task 6: Mount in App Shell

**Files:**

- Modify: `apps/web/src/routes/__root.tsx` or `apps/web/src/components/AppSidebarLayout.tsx`
- Test: `apps/web/src/routes/__root.test.tsx`

**Interfaces:**

- Consumes: `AppStatusBar`.
- Produces: authenticated app layout with bottom status bar.

- [ ] **Step 1: Write failing shell test**

Test:

- authenticated shell renders status bar.
- `/pair` route does not render status bar.
- unauthenticated gate does not render status bar.

Run: `vp test apps/web/src/routes/__root.test.tsx`
Expected: FAIL because status bar is not mounted.

- [ ] **Step 2: Mount status bar**

Wrap the current app shell content in a vertical container that keeps existing sidebar behavior and places `AppStatusBar` at the bottom. Avoid changing pair/auth routing.

- [ ] **Step 3: Verify shell tests**

Run: `vp test apps/web/src/routes/__root.test.tsx apps/web/src/components/status-bar/AppStatusBar.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

Commit with: `feat: mount status bar in app shell`.

---

### Task 7: Full Verification and Browser Test

**Files:**

- No planned production changes unless tests reveal issues.

**Interfaces:**

- Consumes completed Tasks 1-6.
- Produces verified implementation.

- [ ] **Step 1: Run targeted package tests**

Run:

```powershell
vp test packages/contracts/src/providerUsage.test.ts apps/server/src/providerUsage/ProviderUsageService.test.ts apps/server/src/providerUsage/codexUsageFetcher.test.ts apps/web/src/components/status-bar/statusBarFormat.test.ts apps/web/src/components/status-bar/statusBarPresentation.test.ts apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/routes/__root.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run all unit tests**

Run: `vp test`

Expected: PASS. If failures are caused by this feature, fix them with failing tests first where practical, then rerun.

- [ ] **Step 3: Run repo completion checks**

Run:

```powershell
vp check
vp run typecheck
```

Expected: PASS. If unrelated pre-existing failures appear, document them with exact output and continue only after confirming they are unrelated.

- [ ] **Step 4: Verify in browser**

Use Playwright/Chrome against `http://localhost:5733/`:

- status bar is visible at bottom.
- refresh button is clickable.
- Claude/Codex provider popovers open.
- Resource Manager popover opens.
- desktop and narrow viewport layouts do not overlap.

- [ ] **Step 5: Final commit**

Commit verification fixes, if any, with a focused message.

---

## Self-Review

- Spec coverage: The plan covers provider usage, resource manager, responsive bar, tests, full verification, and browser verification. Out-of-scope Orca segments remain follow-ups.
- Placeholder scan: No `TBD`, `TODO`, or unspecified "write tests" steps remain; each task lists expected tests and commands.
- Type consistency: Provider usage contract names are used consistently from contracts through server/client/UI tasks.
