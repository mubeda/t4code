# Plan 04 — COMMITS History Section

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read [00-overview.md](./00-overview.md) first. **Depends on Plan 01** (the panel). Independent of Plans 02/03.

**Goal:** Add the collapsible bottom **COMMITS** section from the Orca screenshot — a recent-commit list (`git log`) that loads lazily the first time the user expands it.

**Architecture:** A new read RPC `vcs.listCommits` runs `git log` with a machine-readable format in `GitVcsDriverCore`, delegated through `GitManager` → `GitWorkflowService`, registered per the [00-overview.md](./00-overview.md) RPC checklist. On the client, a `vcsEnvironment.listCommits` query atom feeds a `SourceControlCommits` component mounted at the bottom of `SourceControlPanel`, gated on an expand toggle.

**Tech Stack:** Effect `Schema`/`RpcGroup` (contracts), Effect + raw `git log` (server), React + `@effect/atom-react` (client). Tests: `vite-plus/test`; server `it.effect`.

## Global Constraints

See [00-overview.md → Global Constraints](./00-overview.md#global-constraints) and the **RPC registration checklist** in [03-staged-unstaged-index.md](./03-staged-unstaged-index.md#global-constraints). `vcs.listCommits` is a **read** RPC → `AuthOrchestrationReadScope`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/git.ts` *(modify)* | `VcsCommit`, `VcsListCommitsInput`, `VcsListCommitsResult`. |
| `packages/contracts/src/rpc.ts` *(modify)* | `WS_METHODS.vcsListCommits` + `Rpc.make` + `WsRpcGroup`. |
| `apps/server/src/ws.ts` *(modify)* | read scope + dispatch handler. |
| `apps/server/src/vcs/GitVcsDriver.ts` *(modify)* | `listCommits` interface method. |
| `apps/server/src/vcs/GitVcsDriverCore.ts` *(modify)* | `listCommits` via `git log` + parser. |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` *(modify)* | integration test. |
| `apps/server/src/git/GitManager.ts` *(modify)* | delegate `listCommits`. |
| `apps/server/src/git/GitWorkflowService.ts` *(modify)* | delegate `listCommits`. |
| `packages/client-runtime/src/state/vcs.ts` *(modify)* | `listCommits` query atom. |
| `apps/web/src/components/SourceControlCommits.tsx` *(create)* | collapsible commit list with deferred load. |
| `apps/web/src/components/SourceControlCommits.logic.ts` *(create)* | `formatCommitTimestamp` + parsing helpers. |
| `apps/web/src/components/SourceControlCommits.test.tsx` / `.logic.test.ts` *(create)* | tests. |
| `apps/web/src/components/SourceControlPanel.tsx` *(modify)* | mount the section at the bottom. |

**Interfaces produced:**
- `VcsCommit = { sha: string; shortSha: string; subject: string; authorName: string; authoredAtMs: number }`.
- `VcsListCommitsInput = { cwd: string; limit?: number; cursor?: number }`; `VcsListCommitsResult = { commits: readonly VcsCommit[]; nextCursor: number | null }`.

---

### Task 1: Contract + RPC registration

**Files:**
- Modify: `packages/contracts/src/git.ts`, `packages/contracts/src/rpc.ts`

- [ ] **Step 1: Add the schemas** (`git.ts`, near the other results)

```ts
export const VcsCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  shortSha: TrimmedNonEmptyString,
  subject: Schema.String,
  authorName: Schema.String,
  authoredAtMs: NonNegativeInt,
});
export type VcsCommit = typeof VcsCommit.Type;

export const VcsListCommitsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
  cursor: Schema.optional(NonNegativeInt),
});
export type VcsListCommitsInput = typeof VcsListCommitsInput.Type;

export const VcsListCommitsResult = Schema.Struct({
  commits: Schema.Array(VcsCommit),
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
});
export type VcsListCommitsResult = typeof VcsListCommitsResult.Type;
```

- [ ] **Step 2: Register the RPC** (`rpc.ts`): add `vcsListCommits: "vcs.listCommits"` to `WS_METHODS` (VCS group), import the new types, add

```ts
export const WsVcsListCommitsRpc = Rpc.make(WS_METHODS.vcsListCommits, {
  payload: VcsListCommitsInput,
  success: VcsListCommitsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});
```

and add `WsVcsListCommitsRpc` to `WsRpcGroup`.

- [ ] **Step 3: Typecheck contracts + commit**

Run: `pnpm --filter @t3tools/contracts exec tsc --noEmit` → PASS.

```bash
git add packages/contracts/src/git.ts packages/contracts/src/rpc.ts
git commit -m "feat(contracts): add vcs.listCommits RPC"
```

---

### Task 2: Server — `listCommits` via `git log`

**Files:**
- Modify: `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/git/GitManager.ts`, `apps/server/src/git/GitWorkflowService.ts`
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

**Interfaces:**
- Produces: `listCommits(input: VcsListCommitsInput) → Effect<VcsListCommitsResult, GitCommandError>` on all three service layers.

- [ ] **Step 1: Failing integration test** (`GitVcsDriverCore.test.ts`)

```ts
it.effect("lists recent commits with subject and author", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "second.txt", "second\n");
    yield* git(cwd, ["add", "second.txt"]);
    yield* git(cwd, ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-m", "second commit"]);

    const result = yield* (yield* GitVcsDriver.GitVcsDriver).listCommits({ cwd, limit: 10 });
    assert.isAtLeast(result.commits.length, 2);
    assert.equal(result.commits[0]?.subject, "second commit");
    assert.equal(result.commits[0]?.authorName, "Ada");
    assert.isTrue(result.commits[0]!.authoredAtMs > 0);
  }),
);
```

Run → FAIL (`listCommits` missing).

- [ ] **Step 2: Implement `listCommits`** (`GitVcsDriverCore.ts`)

Add a parser near the other pure parsers (after `parsePorcelainFileStatus`), using `\x1f` (unit separator) between fields:

```ts
const COMMIT_FIELD_SEP = "\x1f";

export function parseGitLogLine(
  line: string,
): { sha: string; shortSha: string; subject: string; authorName: string; authoredAtMs: number } | null {
  if (line.trim().length === 0) return null;
  const [sha, shortSha, subject, authorName, authoredAt] = line.split(COMMIT_FIELD_SEP);
  if (!sha || !shortSha) return null;
  const seconds = Number.parseInt(authoredAt ?? "0", 10);
  return {
    sha,
    shortSha,
    subject: subject ?? "",
    authorName: authorName ?? "",
    authoredAtMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
  };
}
```

Add the driver method (uses the confirmed `runGitStdoutWithOptions`/`executeGit`; `git log` is already used elsewhere in this file):

```ts
  const listCommits: GitVcsDriver.GitVcsDriver["Service"]["listCommits"] = Effect.fn("listCommits")(
    function* (input) {
      const limit = input.limit ?? 30;
      const cursor = input.cursor ?? 0;
      const result = yield* executeGit(
        "GitVcsDriver.listCommits",
        input.cwd,
        [
          "log",
          `--max-count=${limit + 1}`,
          `--skip=${cursor}`,
          `--pretty=format:%H${COMMIT_FIELD_SEP}%h${COMMIT_FIELD_SEP}%s${COMMIT_FIELD_SEP}%an${COMMIT_FIELD_SEP}%at`,
        ],
        { allowNonZeroExit: true },
      );
      if (result.exitCode !== 0) {
        // Empty repo (no commits yet) → treat as no history.
        return { commits: [], nextCursor: null };
      }
      const parsed = result.stdout
        .split(/\r?\n/g)
        .map((line) => parseGitLogLine(line))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const hasMore = parsed.length > limit;
      const commits = hasMore ? parsed.slice(0, limit) : parsed;
      return { commits, nextCursor: hasMore ? cursor + limit : null };
    },
  );
```

Add `listCommits` to the returned driver object, and declare it on the `GitVcsDriver` `Service` interface (`GitVcsDriver.ts`):

```ts
    readonly listCommits: (
      input: VcsListCommitsInput,
    ) => Effect.Effect<VcsListCommitsResult, GitCommandError>;
```

(Import `VcsListCommitsInput`, `VcsListCommitsResult` in `GitVcsDriver.ts`.)

- [ ] **Step 3: Delegate through `GitManager` + `GitWorkflowService`**

`GitManager.ts` — add `const listCommits = Effect.fn("listCommits")(function* (input) { return yield* gitCore.listCommits(input); });`, declare it on the interface, add to the returned object.

`GitWorkflowService.ts` — add `readonly listCommits: (input: VcsListCommitsInput) => Effect.Effect<VcsListCommitsResult, GitCommandError>;` to the interface and `listCommits: (input) => gitManager.listCommits(input)` to the impl.

- [ ] **Step 4: Run test + typecheck + commit**

Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts` → PASS.
Run: `pnpm --filter @t3tools/server exec tsc --noEmit` → PASS.

```bash
git add apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/git/GitManager.ts apps/server/src/git/GitWorkflowService.ts
git commit -m "feat(server): list recent commits via git log"
```

---

### Task 3: Server — dispatch + scope

**Files:**
- Modify: `apps/server/src/ws.ts`

- [ ] **Step 1: Add scope + handler**

Scope list (line 309): `[WS_METHODS.vcsListCommits, AuthOrchestrationReadScope],`

Dispatch (near the `vcsListRefs` handler, line 1522):

```ts
        [WS_METHODS.vcsListCommits]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListCommits, gitWorkflow.listCommits(input), {
            "rpc.aggregate": "vcs",
          }),
```

- [ ] **Step 2: Typecheck + server test + commit**

Run: `pnpm --filter @t3tools/server exec tsc --noEmit` → PASS.
Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/server.test.ts` → PASS.

```bash
git add apps/server/src/ws.ts
git commit -m "feat(server): dispatch vcs.listCommits"
```

---

### Task 4: Client — query atom + commits component

**Files:**
- Modify: `packages/client-runtime/src/state/vcs.ts`
- Create: `apps/web/src/components/SourceControlCommits.logic.ts` (+ test), `apps/web/src/components/SourceControlCommits.tsx` (+ test)
- Modify: `apps/web/src/components/SourceControlPanel.tsx`

**Interfaces:**
- Produces: `vcsEnvironment.listCommits` query atom; `SourceControlCommits` component; `formatCommitTimestamp(ms, nowMs) → string`.

- [ ] **Step 1: Add the query atom** (`packages/client-runtime/src/state/vcs.ts`, next to `listRefs`)

```ts
    listCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:list-commits",
      tag: WS_METHODS.vcsListCommits,
      staleTimeMs: 10_000,
    }),
```

- [ ] **Step 2: Failing logic test** (`SourceControlCommits.logic.test.ts`)

```ts
import { describe, expect, it } from "vite-plus/test";

import { formatCommitTimestamp } from "./SourceControlCommits.logic";

describe("formatCommitTimestamp", () => {
  const now = 1_000_000_000_000; // fixed reference passed in explicitly
  it("formats recent commits as relative", () => {
    expect(formatCommitTimestamp(now - 5_000, now)).toBe("just now");
    expect(formatCommitTimestamp(now - 3 * 60_000, now)).toBe("3m ago");
    expect(formatCommitTimestamp(now - 2 * 3_600_000, now)).toBe("2h ago");
  });
  it("formats older commits as days", () => {
    expect(formatCommitTimestamp(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
});
```

Run → FAIL.

- [ ] **Step 3: Implement the logic** (`SourceControlCommits.logic.ts`)

```ts
export function formatCommitTimestamp(atMs: number, nowMs: number): string {
  const deltaSeconds = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (deltaSeconds < 30) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}
```

Run → PASS.

- [ ] **Step 4: Failing render test** (`SourceControlCommits.test.tsx`)

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SourceControlCommitRow } from "./SourceControlCommits";

describe("SourceControlCommitRow", () => {
  it("renders the short sha, subject and author", () => {
    const markup = renderToStaticMarkup(
      <SourceControlCommitRow
        commit={{ sha: "abcdef1234", shortSha: "abcdef1", subject: "Fix the thing", authorName: "Ada", authoredAtMs: 1 }}
        nowMs={2}
      />,
    );
    expect(markup).toContain("abcdef1");
    expect(markup).toContain("Fix the thing");
    expect(markup).toContain("Ada");
  });
});
```

Run → FAIL.

- [ ] **Step 5: Implement the component** (`SourceControlCommits.tsx`)

```tsx
import type { VcsCommit } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { formatCommitTimestamp } from "./SourceControlCommits.logic";

export function SourceControlCommitRow({ commit, nowMs }: { commit: VcsCommit; nowMs: number }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs">
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{commit.shortSha}</span>
      <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{commit.authorName}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{formatCommitTimestamp(commit.authoredAtMs, nowMs)}</span>
    </div>
  );
}

export function SourceControlCommits({ threadRef, gitCwd, nowMs }: {
  threadRef: ScopedThreadRef;
  gitCwd: string | null;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // Deferred first load: only subscribe once expanded.
  const query = useEnvironmentQuery(
    expanded && gitCwd !== null
      ? vcsEnvironment.listCommits({ environmentId: threadRef.environmentId, input: { cwd: gitCwd, limit: 30 } })
      : null,
  );
  const commits = query.data?.commits ?? [];
  return (
    <div className="border-t border-border/60">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1 px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <ChevronDownIcon className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")} />
        Commits
      </button>
      {expanded ? (
        query.isPending && commits.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Loading commits…</p>
        ) : commits.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">No commits yet</p>
        ) : (
          <div className="max-h-48 overflow-auto pb-1">
            {commits.map((commit) => (
              <SourceControlCommitRow key={commit.sha} commit={commit} nowMs={nowMs} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
```

Run the render test → PASS.

- [ ] **Step 6: Mount it in the panel**

`SourceControlPanel.tsx` — import `SourceControlCommits`, and render it just before the closing `</DiffPanelShell>` (below the changes body, matching the screenshot's docked-bottom placement). Pass a `nowMs` from `Date.now()` captured on render (fine for a display-only relative timestamp; the component takes it as a prop to stay pure and testable):

```tsx
        <SourceControlCommits threadRef={threadRef} gitCwd={gitCwd} nowMs={Date.now()} />
```

- [ ] **Step 7: Typecheck + web tests + manual + commit**

Run: `pnpm --filter @t3tools/web exec tsgo --noEmit` → PASS.
Run: `pnpm --filter @t3tools/web exec vp test run --project unit apps/web/src/components/SourceControlCommits.logic.test.ts apps/web/src/components/SourceControlCommits.test.tsx` → PASS.
Manual: `pnpm dev:web` → the panel shows a collapsed **COMMITS** header; expanding it loads recent commits (short sha, subject, author, relative time); collapsed on first open (deferred load).

```bash
git add packages/client-runtime/src/state/vcs.ts apps/web/src/components/SourceControlCommits.tsx apps/web/src/components/SourceControlCommits.logic.ts apps/web/src/components/SourceControlCommits.test.tsx apps/web/src/components/SourceControlCommits.logic.test.ts apps/web/src/components/SourceControlPanel.tsx
git commit -m "feat(source-control): add collapsible commits history section"
```

---

## Self-Review (Plan 04)

- **Spec coverage:** the bottom **COMMITS** collapsible with deferred first load ✅.
- **Placeholder scan:** complete code throughout; the `git log` command and format string are exact; the server delegations use confirmed primitives.
- **Type consistency:** `VcsCommit` fields match between contract, `parseGitLogLine`, and the component; RPC name `vcs.listCommits` matches [00-overview.md](./00-overview.md).
