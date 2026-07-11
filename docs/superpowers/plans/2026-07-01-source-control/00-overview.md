# Source Control Surface — Implementation Suite (Overview)

> Status: archival. This implementation suite has shipped into the right-panel
> Source Control surface. For current user-facing behavior, see
> [Source Control Panel](../../../integrations/source-control-providers.md#source-control-panel)
> and [Workspace UI](../../../user/workspace-ui.md#source-control).

> Do not execute commands in this suite as current instructions. Paths and
> commands capture the repository at planning time; use
> [Current Scripts](../../../reference/scripts.md) for the supported command
> surface.

**Goal:** Add a "Source Control" item to the right-panel "Open a surface" chooser and implement a persistent git panel modeled on Orca's Source Control panel (changed-files list, staging, commit message, commit/push/create-PR, per-file status badges, a commits history section, and an AI-generated commit message).

**Architecture:** The web app (`apps/web`, React 19 + zustand + `@effect/atom-react`) already has a right-panel "surface" system and a **complete git backend** reached over an Effect-RPC WebSocket. `VcsStatusResult` already carries the changed-files list (`workingTree.files`) and `useGitStackedAction` already performs commit/push/create-PR in one streaming call. Plan 01 introduces a new `sourceControl` surface kind and a `SourceControlPanel` that composes those existing pieces. Plans 02–05 add the capabilities the current backend lacks (per-file status letters, real index staging, a `git log` history endpoint, a standalone commit-message-generation endpoint), each extending contracts (`packages/contracts`) → server (`apps/server`) → client (`apps/web`) in that order.

**Tech Stack:** TypeScript, React 19.2, zustand 5 (with `persist`), `@effect/atom-react` + `effect` Schema (contracts & RPC), Tailwind 4, `@base-ui/react`, lucide-react, `@pierre/diffs`. Server git via raw `git` CLI wrapped in Effect (`apps/server/src/vcs/GitVcsDriverCore.ts`). Test harness: `vite-plus/test` (imported as `from "vite-plus/test"`).

---

## Why this is a suite, not one plan

You chose **full Orca fidelity**. That spans four independent backend subsystems on top of the core panel (per-file status, index staging, commit history, AI message generation). Per the `superpowers:writing-plans` **Scope Check**, multi-subsystem work is split into separate plans, each of which **produces working, testable software on its own**:

| #      | Plan                                                           | New backend                                                | Depends on         | Screenshot elements delivered                                                                                                                                                                              |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **01** | [Surface + core panel](./01-surface-and-core-panel.md)         | none (pure composition)                                    | —                  | The "Source Control" chooser card + tab + icon; message box; changed-files list with `+/-`; primary **Commit / Push / Create PR** split-button + dropdown; `vs <base>`/PR context; file-row → Diff surface |
| **02** | [Per-file status badges](./02-file-status-badges.md)           | small (porcelain XY + 1 contract field)                    | 01                 | The colored `U` / `M` / `A` / `D` / `R` badge on each file row                                                                                                                                             |
| **03** | [Staged / unstaged index model](./03-staged-unstaged-index.md) | large (`git add`/`restore`/`clean` RPCs + area on entries) | 01, 02             | Separate **Staged Changes** / **Changes** / **Untracked Files** sections; `Stage All` / `Unstage` / `Discard`                                                                                              |
| **04** | [COMMITS history section](./04-commits-history.md)             | medium (`git log` RPC)                                     | 01                 | The collapsible bottom **COMMITS** list with deferred first load                                                                                                                                           |
| **05** | [AI commit message](./05-ai-commit-message.md)                 | medium (standalone generate RPC)                           | 01 (nicer with 03) | The ✨ sparkle that fills an **editable** commit-message box, with cancel                                                                                                                                  |

Each plan ends with a shippable increment. Ship 01 alone and users get a working Source Control panel; 02–05 layer fidelity on top.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the codebase.

- **Monorepo tooling is `vite-plus` (`vp`), not npm/vitest directly.** In this environment **pnpm is invoked as `corepack pnpm`** (pnpm is not on PATH; corepack activates the pinned `pnpm@10.24.0`). A benign `WARN Unsupported engine` (node 24.12 vs wanted 24.13) prints on every command — ignore it. Commands (run from repo root `X:\Workspaces\Orca\t4code\source-control`):
  - **Paths are package-relative when run via `--filter <pkg> exec`** (`vp` runs inside the package dir): use `src/foo.test.ts`, **not** `apps/web/src/foo.test.ts`.
  - **Package names/filters:** web = `@t4code/web`; **server = `t4code`** (NOT `@t4code/server`); contracts = `@t4code/contracts`; client-runtime = `@t4code/client-runtime`; shared = `@t4code/shared`. (Verify a package name with `corepack pnpm ls -r --depth -1` if unsure.)
  - Typecheck one package: `corepack pnpm --filter @t4code/web exec tsgo --noEmit` (web) / `corepack pnpm --filter t4code exec tsgo --noEmit` (server — uses `tsgo`, not `tsc`).
  - Test one file — web: `corepack pnpm --filter @t4code/web exec vp test run --project unit src/rightPanelStore.test.ts`. Server: `corepack pnpm --filter t4code exec vp test run src/vcs/GitVcsDriverCore.test.ts` (server has NO `--project` flag; server git tests spawn real `git` and take ~40s).
  - Lint: `corepack pnpm lint` (oxlint via `vp lint`). Format: `corepack pnpm fmt` (check with `corepack pnpm fmt:check`).
  - **Every `pnpm …` command written in Plans 01–05 should be read as `corepack pnpm …` with package-relative test paths** — the plans predate this environment detail; this bullet governs.
- **Test imports come from `vite-plus/test`** (`import { describe, it, expect, beforeEach } from "vite-plus/test"`), **never** from `vitest`. Component tests render with `renderToStaticMarkup` from `react-dom/server` and assert on the markup string (see `apps/web/src/components/ThreadStatusIndicators.test.tsx`).
- **Contracts are Effect `Schema`** (`import * as Schema from "effect/Schema"`) in `packages/contracts/src`. Every wire type is a `Schema.Struct`/`Schema.Literals`; adding a field means editing the schema, and its `.Type` flows everywhere. Reuse the existing base schemas from `./baseSchemas.ts` (`TrimmedNonEmptyString`, `NonNegativeInt`, `PositiveInt`).
- **New RPC methods** are registered in `packages/contracts/src/rpc.ts` (`WS_METHODS` map + an `Rpc.make(...)` definition), then dispatched in `apps/server/src/ws.ts`, then exposed to the client via an atom factory in `packages/client-runtime/src/state/*` and a thin binding in `apps/web/src/state/*`.
- **Auth scopes:** read-only RPCs register a `read` scope, mutating RPCs an `operate` scope, in `apps/server/src/ws.ts` (see the existing `subscribeVcsStatus` → read and `gitRunStackedAction` → operate registrations).
- **zustand stores use `persist` + `resolveStorage`** (`apps/web/src/lib/storage.ts`); bump the store's `version` when its persisted shape changes.
- **No new runtime dependencies.** Everything needed (icons, UI primitives, git backend, RPC) already exists in the workspace. Reuse `~/components/ui/*` primitives and `lucide-react` icons.
- **Follow existing file conventions:** branchy logic goes in a co-located `*.logic.ts` with a `*.logic.test.ts`; components stay presentational. Import alias `~/` = `apps/web/src/`.
- **Terminology is provider-aware:** never hard-code "PR" / "pull request". Derive it via `getSourceControlPresentation(provider).terminology` (`.shortLabel` = e.g. "PR"/"MR", `.singular` = "pull request"/"merge request").

---

## Shared Interfaces & Naming (anti-drift — all plans reference these)

These names are fixed once here so tasks written independently stay consistent.

### New surface kind (Plan 01)

- Kind string: **`"sourceControl"`** — added to `RIGHT_PANEL_KINDS` in `apps/web/src/rightPanelStore.ts`.
- Surface descriptor: **`{ id: "sourceControl"; kind: "sourceControl" }`** (a singleton surface, like `diff`/`files`/`plan`).
- Bump `RIGHT_PANEL_STORAGE_VERSION` from `7` → **`8`**.
- Tab title: **`"Source Control"`**. Tab/menu icon: lucide **`GitPullRequestArrow`** (matches Orca's Create-PR icon; falls back cleanly for all providers).
- Empty-state card copy: label **`"Source Control"`**, description **`"Stage, commit, and open changes."`**.
- Disabled reason: **`"Source control is only available for server threads in Git repositories."`** (keyed `sourceControl` in `SURFACE_DISABLED_REASONS`).
- Availability prop: **`sourceControlAvailable={isServerThread && isGitRepo}`**; add-callback: **`onAddSourceControl`** / `addSourceControlSurface`.

### Core panel (Plan 01)

- Component: **`apps/web/src/components/SourceControlPanel.tsx`**, default export **`SourceControlPanel`**, props `{ mode: DiffPanelMode; threadRef: ScopedThreadRef; gitCwd: string | null }`.
- Logic module: **`apps/web/src/components/SourceControlPanel.logic.ts`** (+ `.logic.test.ts`).
- Draft store: **`apps/web/src/sourceControlPanelStore.ts`** (zustand+persist, `name: "t4code:source-control-panel-state:v1"`), holding per-thread commit-message draft and the excluded-file set. Selector **`selectThreadSourceControlDraft`**.
- Reuses verbatim: `vcsEnvironment.status(...)`, `useGitStackedAction(scope)`, `useVcsPullAction`, `useVcsInitAction`, `useSourceControlActionRunning`, `getSourceControlPresentation`, and the pure helpers in `GitActionsControl.logic.ts` (`buildMenuItems`, `resolveQuickAction`, `buildGitActionProgressStages`, `resolveThreadBranchUpdate`, etc.).
- File-row click → open the Diff surface: `useRightPanelStore.getState().open(threadRef, "diff")` then `useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged")`.

### Per-file status (Plan 02)

- Status letter type in contracts: **`VcsWorkingTreeFileStatus = Schema.Literals(["modified","added","deleted","renamed","copied","untracked"])`** in `packages/contracts/src/git.ts`.
- New field on each `workingTree.files[]` entry: **`status: Schema.optional(VcsWorkingTreeFileStatus)`** — **optional** so no existing `VcsStatusResult` fixture needs editing; the server always populates it and the client defaults a missing value to `"modified"`.
- Presentation helper: **`apps/web/src/sourceControlStatus.ts`** exporting `WORKING_TREE_STATUS_BADGE: Record<VcsWorkingTreeFileStatus, { letter: string; className: string; label: string }>` (letters `M/A/D/R/C/U`) + `workingTreeStatusBadge(status)`.

### Index staging (Plan 03)

- New field on each file entry: **`area: Schema.Literals(["staged","unstaged","untracked"])`** (`VcsStagingArea`).
- New RPC methods (in `WS_METHODS`): **`vcsStageFiles: "vcs.stageFiles"`**, **`vcsUnstageFiles: "vcs.unstageFiles"`**, **`vcsDiscardFiles: "vcs.discardFiles"`**.
- New client action hooks: **`useVcsStageAction`**, **`useVcsUnstageAction`**, **`useVcsDiscardAction`** in `apps/web/src/state/sourceControlActions.ts`.

### Commit history (Plan 04)

- New RPC method: **`vcsListCommits: "vcs.listCommits"`**; input `VcsListCommitsInput { cwd; limit?; cursor? }`; result `VcsListCommitsResult { commits: VcsCommit[]; nextCursor: number | null }`; `VcsCommit { sha; shortSha; subject; authorName; authoredAtMs; }`.
- Client: **`vcsEnvironment.listCommits`** (query atom); component **`apps/web/src/components/SourceControlCommits.tsx`**.

### AI commit message (Plan 05)

- New RPC method: **`vcsGenerateCommitMessage: "vcs.generateCommitMessage"`**; input `VcsGenerateCommitMessageInput { cwd; filePaths? }`; result `VcsGenerateCommitMessageResult { message: string }`; a `cancel` handled via RPC stream interruption.
- Client action hook: **`useVcsGenerateCommitMessageAction`**; wired to a ✨ button that writes into the Plan-01 draft store's `message` field.

---

## Spec coverage vs the Orca screenshot

| Screenshot element                                                       | Covered by                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| "Source Control" item with description + icon in the chooser             | Plan 01                                                              |
| `Create PR` button + `vs <base>` context row                             | Plan 01 (primary action + branch/PR context)                         |
| Commit `Message` box                                                     | Plan 01                                                              |
| `+ Stage All` split button + chevron dropdown                            | Plan 01 (selection model) → Plan 03 (real staging)                   |
| `UNTRACKED FILES 11` / `Changes` / `Staged Changes` collapsible sections | Plan 03                                                              |
| File row: name, dir hint, green `+156`, `U` badge                        | `+/-` counts Plan 01; `U`/status badge Plan 02; area/section Plan 03 |
| `View all` per section                                                   | Plan 01 (opens Diff surface for the working tree)                    |
| ✨ AI commit message                                                     | Plan 05                                                              |
| bottom `COMMITS` section                                                 | Plan 04                                                              |

> **Note on `Search` + `...` overflow menu** (top-right of Orca's panel): these are secondary chrome. They are intentionally **out of scope** for this suite; if wanted, add them as a small follow-up plan once 01–05 land. This omission is called out here so it is not mistaken for missing coverage.

---

## Execution Handoff

After the suite is reviewed, execute with **superpowers:subagent-driven-development** (recommended) — one fresh subagent per task, review between tasks — starting with Plan 01. Do not begin a later plan until its dependencies (per the table above) are merged, because later plans edit the `SourceControlPanel` and contract types created earlier.
