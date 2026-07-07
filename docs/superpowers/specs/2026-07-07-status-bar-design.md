# T4Code Status Bar Design

Date: 2026-07-07

## Context

Orca's status bar is a bottom application bar that combines provider usage, refresh controls, and operational status. The visible screenshot shows Claude and Codex quota windows on the left, then resource indicators on the right: memory, terminal sessions, and a small repository/process count. The Orca source shows that the visible strip is backed by several larger systems:

- Provider rate-limit snapshots for Claude, Codex, Gemini, OpenCode Go, Kimi, and MiniMax.
- Provider detail popovers with reset timing, unavailable/error states, and account/runtime controls.
- A Resource Manager popover that merges process memory samples, terminal sessions, worktree grouping, orphan detection, and kill actions.
- Optional status items for SSH hosts, ports, update state, pet overlay, and floating terminal controls.
- Status bar visibility and per-item display settings.

T4Code already has useful foundations:

- `server.getProcessDiagnostics`, `server.getProcessResourceHistory`, and `server.signalProcess` in contracts and server handlers.
- The Diagnostics Settings panel already consumes process/resource data and renders process tables/charts.
- Terminal metadata is already exposed through the terminal environment state and `useKnownTerminalSessions`.
- Provider snapshots already include installed/enabled/auth/status information, but do not include rate-limit or quota windows.

## Scope

Implement a T4Code-focused first version of the Orca-style status bar:

- Bottom status bar mounted in the authenticated app shell.
- Claude and Codex usage/rate-limit segments with Orca-like compact bars, refresh state, error/unavailable states, and detail popovers.
- Resource Manager segment with total child-process memory, total child-process CPU, terminal session count, top process list, history chart, and kill actions using existing diagnostics endpoints.
- Responsive compact/icon-only behavior by available width.
- Unit tests for pure formatting/presentation logic, resource aggregation, provider usage mapping, and shell integration.
- Full verification after implementation: `vp test`, fix failures caused by the work, then `vp check` and `vp run typecheck`.

Out of scope for this first pass:

- Gemini, OpenCode Go, Kimi, and MiniMax rate-limit fetchers.
- Claude/Codex account switching inside the status bar.
- SSH host status, ports status, update status, pet status, and floating terminal toggle.
- Workspace disk-space cleanup UI.
- Transcript token/cost analytics pages.

The design keeps extension points for those items so they can be added without replacing the first version.

## User Experience

The status bar sits at the bottom of the main app, below the current page content. It uses the existing T4Code UI primitives (`Tooltip`, `Popover`, `Button`, menu primitives, and icons from `lucide-react`) and a restrained 24px-high layout.

Left side:

- Claude usage segment, if Claude is configured or installed.
- Codex usage segment, if Codex is configured or installed.
- Refresh button that refreshes provider usage snapshots.

Each provider segment shows:

- Provider icon.
- A thin usage bar for the 5-hour/session window when available.
- A thin usage bar for the weekly window when available.
- Remaining percentage labels, matching Orca's convention of showing quota left rather than quota used.
- Fetching, unavailable, and error states.

Provider popovers show:

- Current state.
- Session and weekly windows.
- Used/remaining percentages.
- Reset time when available.
- Last updated timestamp.
- Error/unavailable details when fetches fail.

Right side:

- Resource Manager segment with memory label and terminal count.

Resource popover shows:

- Summary stats: memory, CPU, process count, terminal sessions.
- Process resource history chart from `server.getProcessResourceHistory`.
- Top process rows sorted by CPU time, including current CPU and memory.
- Terminal session rows from terminal metadata.
- Per-process `SIGINT` and `SIGKILL` actions using existing `server.signalProcess`, with the same safety behavior as Diagnostics Settings for `SIGKILL`.

## Server Design

Add a provider usage service rather than embedding fetch logic in WebSocket handlers.

Contracts:

- Add schema-only usage DTOs in `packages/contracts/src/statusBar.ts` or `packages/contracts/src/providerUsage.ts`.
- Export from `packages/contracts/src/index.ts`.
- Add RPC methods in `packages/contracts/src/rpc.ts`:
  - `server.getProviderUsage`
  - `server.refreshProviderUsage`

Core DTOs:

- `ServerProviderUsageProvider = "claude" | "codex"`
- `ServerProviderUsageStatus = "idle" | "fetching" | "ok" | "error" | "unavailable"`
- `ServerProviderUsageWindow`
  - `usedPercent`
  - `windowMinutes`
  - `resetsAt`
  - `resetDescription`
- `ServerProviderUsageSnapshot`
  - `provider`
  - `status`
  - `session`
  - `weekly`
  - `updatedAt`
  - `error`
  - `metadata`
- `ServerProviderUsageResult`
  - `providers`
  - `isFetching`
  - `readAt`

Server implementation:

- Add `apps/server/src/statusBar/ProviderUsageService.ts`.
- Keep an in-memory snapshot for Claude and Codex.
- Polling policy mirrors Orca's conservative behavior:
  - default refresh interval: 15 minutes
  - minimum manual refresh debounce: 30 seconds
  - stale threshold: 30 minutes
  - single-flight fetches per provider
- Fetch Codex via the local Codex app-server JSON-RPC when possible:
  - invoke Codex with the same runtime home/environment conventions used by T4Code's Codex driver where practical.
  - call `account/rateLimits/read`.
  - normalize `primary` as session and `secondary` as weekly.
- Fetch Claude by checking OAuth usage credentials when available, with a minimal first-pass fallback:
  - classify missing credentials as unavailable.
  - normalize OAuth usage windows into the same DTO.
  - keep PTY fallback as a later extension if it would require invasive terminal/session behavior.

The first pass should prefer accurate unavailable/error states over pretending to have data.

## Client Design

State:

- Extend `packages/client-runtime/src/state/server.ts` with provider usage query/command atom families.
- Add `apps/web/src/state/statusBar.ts` for small app-level selectors:
  - primary environment usage query
  - refresh command wrapper
  - terminal session count selector
  - resource diagnostics query inputs

Components:

- `apps/web/src/components/status-bar/AppStatusBar.tsx`
- `ProviderUsageSegment.tsx`
- `ProviderUsagePopover.tsx`
- `ResourceUsageSegment.tsx`
- `ResourceUsagePopover.tsx`
- `statusBarFormat.ts`
- `statusBarPresentation.ts`

Mounting:

- Update `apps/web/src/routes/__root.tsx` or `AppSidebarLayout` so the app shell is a vertical layout:
  - main content grows and scrolls as it does today.
  - status bar stays pinned at the bottom.
  - pair/auth pages do not render the status bar.

Performance:

- The status bar should avoid subscribing to expensive process tables unless the resource popover is open.
- The closed resource segment can use the cheaper process diagnostics summary and terminal metadata count.
- Resource history and detailed process rows refresh when the popover opens, then on a modest interval while open.

## Testing

Unit tests:

- Provider usage formatting:
  - remaining percentage labels.
  - bar colors.
  - missing/error/unavailable/fetching states.
- Provider usage normalization:
  - Codex primary/secondary windows.
  - stale/error states.
- Resource presentation:
  - memory/CPU formatting.
  - sorting top processes.
  - terminal count labels.
  - safe signal button state.
- Shell integration:
  - authenticated root renders the status bar.
  - pair/auth surfaces do not render it.

Verification after implementation:

- Run targeted tests while building.
- Run `vp test`.
- Fix failures caused by this change.
- Run `vp check`.
- Run `vp run typecheck`.
- Verify in the running app with Playwright/Chrome:
  - status bar visible at bottom.
  - provider popover opens.
  - resource popover opens.
  - layout does not overlap at desktop and narrow widths.

## Risks

- Claude usage fetching can be credential-source sensitive. The first pass should surface honest unavailable/error states and leave complex account/PTY fallback for a separate change.
- Codex rate-limit JSON-RPC behavior can change. Keep the mapper isolated and well-tested.
- Process diagnostics are descendants of the T4 server process, not the entire desktop shell. The UI must label this correctly so users do not interpret it as total machine memory.
- Large process tables can churn. Keep detailed resource queries popover-open only.

## Follow-Ups

- Add provider account switching for Claude/Codex.
- Add Gemini/OpenCode Go/Kimi/MiniMax usage providers.
- Add ports and SSH status segments.
- Add persisted status-bar item visibility settings.
- Add workspace disk-space scan/cleanup affordances.
