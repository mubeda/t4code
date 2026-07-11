# Plan 02 — Per-file Status Badges (U / M / A / D / R / C)

> Status: archival. This shipped plan preserves its original paths and commands.
> Use [Current Scripts](../../../reference/scripts.md) for supported commands.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read [00-overview.md](./00-overview.md) first. **Depends on Plan 01** (the panel + `SourceControlChangesList.renderBadge` slot + `WorkingTreeFile` type must already exist).

**Goal:** Surface each changed file's git status as a colored single-letter badge (`M`/`A`/`D`/`R`/`C`/`U`) on its row, matching the Orca screenshot's `U` badge. The server already runs `git status --porcelain=2` and parses each line for its path — this plan keeps the XY status code that is currently discarded and threads it to the client.

**Architecture:** Add an optional `status` field to each `workingTree.files[]` entry in the `VcsStatusResult` contract (`packages/contracts`). Populate it in `GitVcsDriverCore.readStatusDetailsLocal` by deriving a letter from the porcelain-v2 XY pair. On the client, a small `sourceControlStatus.ts` maps the letter to a badge, rendered through the `renderBadge` slot `SourceControlChangesList` already exposes.

**Tech Stack:** Effect `Schema` (contracts), Effect + raw `git` (server), React (client). Tests: `vite-plus/test`; server driver tests use `it.effect` against a real temp git repo.

## Global Constraints

See [00-overview.md → Global Constraints](./00-overview.md#global-constraints). Contract types are Effect `Schema`; `status` is added as **optional** so no existing `VcsStatusResult` fixture across the repo needs editing (the server always populates it; the client defaults a missing value to `"modified"`).

---

## File Structure

| File                                                             | Responsibility                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/contracts/src/git.ts` _(modify)_                       | Add `VcsWorkingTreeFileStatus` literal + optional `status` field on `workingTree.files`. |
| `apps/server/src/vcs/GitVcsDriverCore.ts` _(modify)_             | Export porcelain status helpers; populate `status` when building the files list.         |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` _(modify)_        | Unit tests for the helper + an integration test asserting real status letters.           |
| `apps/web/src/sourceControlStatus.ts` _(create)_                 | Letter + color map for each status.                                                      |
| `apps/web/src/sourceControlStatus.test.ts` _(create)_            | Map unit tests.                                                                          |
| `apps/web/src/components/SourceControlPanel.logic.ts` _(modify)_ | Add optional `status` to `WorkingTreeFile`; pass it through `workingTreeFiles`.          |
| `apps/web/src/components/SourceControlPanel.tsx` _(modify)_      | Render the badge via `renderBadge`.                                                      |

**Interfaces produced (consumed by Plan 03):**

- `VcsWorkingTreeFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked"` (contract).
- `parsePorcelainFileStatus(line) → { path: string; status: VcsWorkingTreeFileStatus } | null` and `statusCharToWorkingTreeStatus(char) → VcsWorkingTreeFileStatus` (exported from `GitVcsDriverCore.ts`).
- `WORKING_TREE_STATUS_BADGE` + `workingTreeStatusBadge(status)` (`sourceControlStatus.ts`).

---

### Task 1: Contract — add the status literal + field

**Files:**

- Modify: `packages/contracts/src/git.ts` (add literal near line 47; extend the `workingTree.files` struct at lines 208-215)

**Interfaces:**

- Produces: `VcsWorkingTreeFileStatus` schema + type; each `workingTree.files[]` entry gains `status?: VcsWorkingTreeFileStatus`.

- [ ] **Step 1: Add the status literal**

`packages/contracts/src/git.ts` — after the other domain literals (e.g. after `GitPullRequestState`, line 47), add:

```ts
export const VcsWorkingTreeFileStatus = Schema.Literals([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
]);
export type VcsWorkingTreeFileStatus = typeof VcsWorkingTreeFileStatus.Type;
```

- [ ] **Step 2: Add the field to the working-tree file struct**

In `VcsStatusLocalShape.workingTree` (lines 208-215), add `status` to each file struct:

```ts
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyString,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
        status: Schema.optional(VcsWorkingTreeFileStatus),
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
```

(`TrimmedNonEmptyString` and `NonNegativeInt` are already imported at the top of this file — see line 2. Note: the original file references `TrimmedNonEmptyStringSchema` as an alias in some structs; use whichever identifier the surrounding struct uses — both resolve to the same schema.)

- [ ] **Step 3: Verify the contract compiles and is exported**

Run: `pnpm --filter @t4code/contracts exec tsc --noEmit`
Expected: PASS. Confirm `packages/contracts/src/index.ts` re-exports `./git` (it already exports `VcsStatusResult`, so `VcsWorkingTreeFileStatus` is exported automatically via `export * from "./git.ts"`). If the index uses named re-exports instead of `export *`, add `VcsWorkingTreeFileStatus` to the `./git` export list.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/git.ts
git commit -m "feat(contracts): add optional per-file working-tree status"
```

---

### Task 2: Server — derive and populate the status letter

**Files:**

- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts` (add helpers near line 162; extend the status loop ~line 1395 and the file-build ~lines 1435-1446)
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

**Interfaces:**

- Consumes: `VcsWorkingTreeFileStatus` from `@t4code/contracts`.
- Produces: `parsePorcelainFileStatus`, `statusCharToWorkingTreeStatus` (exported); `workingTree.files[].status` populated in `readStatusDetailsLocal`.

- [ ] **Step 1: Write the failing unit + integration tests**

Add to `apps/server/src/vcs/GitVcsDriverCore.test.ts`. First add the helper import at the top (next to the existing `GitVcsDriver` import):

```ts
import { parsePorcelainFileStatus, statusCharToWorkingTreeStatus } from "./GitVcsDriverCore";
```

Then add a pure-helper describe block (place it near the top-level `describe`, using the file's existing `describe`/`it` imports — this file uses `@effect/vitest`-style `it.effect`; plain `it` is available from the same import for synchronous cases):

```ts
describe("parsePorcelainFileStatus", () => {
  it("maps untracked, modified, added, deleted and renamed porcelain lines", () => {
    assert.deepStrictEqual(parsePorcelainFileStatus("? new-file.txt"), {
      path: "new-file.txt",
      status: "untracked",
    });
    assert.deepStrictEqual(
      parsePorcelainFileStatus("1 .M N... 100644 100644 100644 aaa bbb tracked.ts"),
      {
        path: "tracked.ts",
        status: "modified",
      },
    );
    assert.deepStrictEqual(
      parsePorcelainFileStatus("1 A. N... 000000 100644 100644 000 ccc added.ts"),
      {
        path: "added.ts",
        status: "added",
      },
    );
    assert.deepStrictEqual(
      parsePorcelainFileStatus("1 .D N... 100644 100644 000000 ddd ddd gone.ts"),
      {
        path: "gone.ts",
        status: "deleted",
      },
    );
    assert.equal(parsePorcelainFileStatus("! ignored.log"), null);
  });

  it("derives letters via statusCharToWorkingTreeStatus", () => {
    assert.equal(statusCharToWorkingTreeStatus("A"), "added");
    assert.equal(statusCharToWorkingTreeStatus("D"), "deleted");
    assert.equal(statusCharToWorkingTreeStatus("R"), "renamed");
    assert.equal(statusCharToWorkingTreeStatus("C"), "copied");
    assert.equal(statusCharToWorkingTreeStatus("M"), "modified");
    assert.equal(statusCharToWorkingTreeStatus("?"), "modified");
  });
});
```

And add an integration test inside the existing driver `describe` (alongside "reports refName and dirty state", ~line 260):

```ts
it.effect("reports per-file working-tree status letters", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "tracked.ts", "export const a = 1;\n");
    yield* git(cwd, ["add", "tracked.ts"]);
    yield* git(cwd, ["commit", "-m", "add tracked"]);
    yield* writeTextFile(cwd, "tracked.ts", "export const a = 2;\n");
    yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

    const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);
    const byPath = new Map(status.workingTree.files.map((file) => [file.path, file.status]));

    assert.equal(byPath.get("tracked.ts"), "modified");
    assert.equal(byPath.get("untracked.txt"), "untracked");
  }),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @t4code/server exec vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts`
Expected: FAIL — `parsePorcelainFileStatus` is not exported; and `file.status` is `undefined` in the integration test.

- [ ] **Step 3: Add the porcelain status helpers**

`apps/server/src/vcs/GitVcsDriverCore.ts` — after `parsePorcelainPath` (ends line 162), add. (Import the type: add `VcsWorkingTreeFileStatus` to the existing `@t4code/contracts` type import at the top of the file — if the file has no such import yet, add `import type { VcsWorkingTreeFileStatus } from "@t4code/contracts";`.)

```ts
export function statusCharToWorkingTreeStatus(char: string): VcsWorkingTreeFileStatus {
  switch (char) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      // M (modified), T (type change) and anything else collapse to "modified".
      return "modified";
  }
}

export function parsePorcelainFileStatus(
  line: string,
): { path: string; status: VcsWorkingTreeFileStatus } | null {
  if (line.startsWith("? ")) {
    const path = line.slice(2).trim();
    return path.length > 0 ? { path, status: "untracked" } : null;
  }
  if (line.startsWith("! ")) {
    return null; // ignored entries are not working-tree changes
  }
  if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
    const path = parsePorcelainPath(line);
    if (!path) return null;
    if (line.startsWith("u ")) {
      return { path, status: "modified" }; // unmerged — collapse to modified
    }
    // porcelain=2 ordinary/rename records: field index 1 is the "XY" pair
    // (X = index status, Y = worktree status). Prefer the worktree char.
    const xy = line.trim().split(/\s+/g)[1] ?? "..";
    const worktreeChar = xy[1] ?? ".";
    const indexChar = xy[0] ?? ".";
    const effective = worktreeChar !== "." ? worktreeChar : indexChar;
    return { path, status: statusCharToWorkingTreeStatus(effective) };
  }
  return null;
}
```

- [ ] **Step 4: Build a `statusByPath` map in the status loop**

In `readStatusDetailsLocal`, add a map declaration next to `changedFilesWithoutNumstat` (line 1375):

```ts
const changedFilesWithoutNumstat = new Set<string>();
const statusByPath = new Map<string, VcsWorkingTreeFileStatus>();
```

Then replace the change-detection branch (lines 1395-1399):

```ts
if (line.trim().length > 0 && !line.startsWith("#")) {
  hasWorkingTreeChanges = true;
  const parsed = parsePorcelainFileStatus(line);
  if (parsed) {
    changedFilesWithoutNumstat.add(parsed.path);
    statusByPath.set(parsed.path, parsed.status);
  } else {
    const pathValue = parsePorcelainPath(line);
    if (pathValue) changedFilesWithoutNumstat.add(pathValue);
  }
}
```

- [ ] **Step 5: Attach `status` when building the files list**

Replace the `files` map (lines 1435-1441) and the untracked-fallback push (lines 1443-1446):

```ts
const files = Array.from(fileStatMap.entries())
  .map(([filePath, stat]) => {
    insertions += stat.insertions;
    deletions += stat.deletions;
    return {
      path: filePath,
      insertions: stat.insertions,
      deletions: stat.deletions,
      status: statusByPath.get(filePath) ?? "modified",
    };
  })
  .toSorted((a, b) => a.path.localeCompare(b.path));

for (const filePath of changedFilesWithoutNumstat) {
  if (fileStatMap.has(filePath)) continue;
  files.push({
    path: filePath,
    insertions: 0,
    deletions: 0,
    status: statusByPath.get(filePath) ?? "modified",
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @t4code/server exec vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck the server**

Run: `pnpm --filter @t4code/server exec tsc --noEmit`
Expected: PASS (the optional field means no other server code breaks).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts
git commit -m "feat(server): derive per-file working-tree status from porcelain"
```

---

### Task 3: Client — badge map + render

**Files:**

- Create: `apps/web/src/sourceControlStatus.ts`
- Test: `apps/web/src/sourceControlStatus.test.ts`
- Modify: `apps/web/src/components/SourceControlPanel.logic.ts` (add optional `status` to `WorkingTreeFile`, pass it through)
- Modify: `apps/web/src/components/SourceControlPanel.tsx` (render the badge)

**Interfaces:**

- Consumes: `VcsWorkingTreeFileStatus` (`@t4code/contracts`).
- Produces: `WORKING_TREE_STATUS_BADGE`, `workingTreeStatusBadge(status)`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/sourceControlStatus.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { workingTreeStatusBadge } from "./sourceControlStatus";

describe("workingTreeStatusBadge", () => {
  it("maps each status to its letter", () => {
    expect(workingTreeStatusBadge("untracked").letter).toBe("U");
    expect(workingTreeStatusBadge("modified").letter).toBe("M");
    expect(workingTreeStatusBadge("added").letter).toBe("A");
    expect(workingTreeStatusBadge("deleted").letter).toBe("D");
    expect(workingTreeStatusBadge("renamed").letter).toBe("R");
    expect(workingTreeStatusBadge("copied").letter).toBe("C");
  });

  it("defaults a missing status to modified", () => {
    expect(workingTreeStatusBadge(undefined).letter).toBe("M");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/sourceControlStatus.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the badge map**

Create `apps/web/src/sourceControlStatus.ts`:

```ts
import type { VcsWorkingTreeFileStatus } from "@t4code/contracts";

interface WorkingTreeStatusBadge {
  readonly letter: string;
  readonly className: string;
  readonly label: string;
}

export const WORKING_TREE_STATUS_BADGE: Record<VcsWorkingTreeFileStatus, WorkingTreeStatusBadge> = {
  modified: { letter: "M", className: "text-warning", label: "Modified" },
  added: { letter: "A", className: "text-success", label: "Added" },
  deleted: { letter: "D", className: "text-destructive", label: "Deleted" },
  renamed: { letter: "R", className: "text-warning", label: "Renamed" },
  copied: { letter: "C", className: "text-success", label: "Copied" },
  untracked: { letter: "U", className: "text-success", label: "Untracked" },
};

export function workingTreeStatusBadge(
  status: VcsWorkingTreeFileStatus | undefined,
): WorkingTreeStatusBadge {
  return WORKING_TREE_STATUS_BADGE[status ?? "modified"];
}
```

(The color tokens `text-warning`, `text-success`, `text-destructive` are already used by `GitActionsControl.tsx`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/sourceControlStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `status` through `WorkingTreeFile`**

`apps/web/src/components/SourceControlPanel.logic.ts` — extend the `WorkingTreeFile` interface and the `workingTreeFiles` mapper:

```ts
import type { VcsStatusResult, VcsWorkingTreeFileStatus } from "@t4code/contracts";

export interface WorkingTreeFile {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly status?: VcsWorkingTreeFileStatus;
}
```

```ts
export function workingTreeFiles(status: VcsStatusResult | null | undefined): WorkingTreeFile[] {
  return status
    ? status.workingTree.files.map((file) => ({
        path: file.path,
        insertions: file.insertions,
        deletions: file.deletions,
        ...(file.status ? { status: file.status } : {}),
      }))
    : [];
}
```

> The existing `SourceControlPanel.logic.test.ts` fixtures omit `status`; since it is optional, those tests still pass unchanged.

- [ ] **Step 6: Render the badge in the panel**

`apps/web/src/components/SourceControlPanel.tsx` — add the import:

```ts
import { workingTreeStatusBadge } from "~/sourceControlStatus";
```

Then pass `renderBadge` to the `SourceControlChangesList` (the `<SourceControlChangesList .../>` in the ScrollArea):

```tsx
<SourceControlChangesList
  files={files}
  excludedPaths={excludedPaths}
  onToggle={(path) => toggleExcludedPath(threadRef, path)}
  onOpenFile={openFileInDiff}
  renderBadge={(file) => {
    const badge = workingTreeStatusBadge(file.status);
    return (
      <span
        className={cn("w-4 shrink-0 text-center text-[10px] font-bold", badge.className)}
        title={badge.label}
        aria-label={badge.label}
      >
        {badge.letter}
      </span>
    );
  }}
/>
```

(`cn` is already imported in `SourceControlPanel.tsx` from Plan 01.)

- [ ] **Step 7: Typecheck + run web tests**

Run: `pnpm --filter @t4code/web exec tsgo --noEmit`
Expected: PASS.
Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/sourceControlStatus.test.ts apps/web/src/components/SourceControlChangesList.test.tsx`
Expected: PASS (the `renderBadge` slot test from Plan 01 already covers badge injection).

- [ ] **Step 8: Manual verification**

`pnpm dev:web` → open the Source Control panel in a dirty repo: each file row now shows a colored letter — `U` (green) for untracked, `M` (amber) for modified, `A` (green) for added, `D` (red) for deleted.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/sourceControlStatus.ts apps/web/src/sourceControlStatus.test.ts apps/web/src/components/SourceControlPanel.logic.ts apps/web/src/components/SourceControlPanel.tsx
git commit -m "feat(source-control): show per-file git status badges"
```

---

## Self-Review (Plan 02)

- **Spec coverage:** the `U` badge (and its M/A/D/R/C siblings) from the screenshot ✅.
- **Placeholder scan:** all steps carry complete code. The one conditional (index re-export style) has a concrete resolution.
- **Type consistency:** `VcsWorkingTreeFileStatus` literal values match between contract, server helper, and client map. `status` is optional throughout, so Plan 01's existing fixtures and tests keep compiling. `WorkingTreeFile.status` feeds the `renderBadge` slot defined in Plan 01.
