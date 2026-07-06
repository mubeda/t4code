# Plan 03 — Staged / Unstaged Index Model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read [00-overview.md](./00-overview.md) first. **Depends on Plans 01 + 02** (the panel, the list, the `status` field, and the porcelain helpers must already exist).

**Goal:** Replace the panel's single "select files to commit" list with Orca's real git-index model: separate **Staged Changes**, **Changes** (unstaged), and **Untracked Files** sections, each with `Stage All` / `Unstage` / `Discard`, backed by real `git add` / `git restore`. Commit commits the **staged** set.

**Architecture:** Add a per-entry `area` (`"staged" | "unstaged" | "untracked"`) to `VcsStatusResult.workingTree.files`, populated by splitting the already-collected staged vs unstaged numstat in `GitVcsDriverCore.readStatusDetailsLocal`. Add three mutating RPCs (`vcs.stageFiles` / `vcs.unstageFiles` / `vcs.discardFiles`) following the exact registration recipe used by `vcs.pull`, delegating through `GitWorkflowService` → `GitManager` → `GitVcsDriverCore` to `git add` / `git restore --staged` / `git restore` + `git clean`. On the client, add three action hooks and refactor `SourceControlPanel` to group changes into collapsible sections and commit the staged set.

**Tech Stack:** Effect `Schema` + `RpcGroup` (contracts), Effect + raw `git` (server), React + zustand (client). Tests: `vite-plus/test`; server `it.effect` against a temp repo.

## Global Constraints

See [00-overview.md → Global Constraints](./00-overview.md#global-constraints). **RPC registration checklist (a new method touches all of these or the server throws at startup):** ① `WS_METHODS` entry (`packages/contracts/src/rpc.ts`), ② `Rpc.make(...)` definition, ③ add to `WsRpcGroup = RpcGroup.make(...)` (rpc.ts:684), ④ auth-scope entry in the scope list (`apps/server/src/ws.ts:309-312` — a method with no declared scope throws at ws.ts:459), ⑤ dispatch handler (ws.ts:1453+), ⑥ client atom in `createVcsEnvironmentAtoms` (`packages/client-runtime/src/state/vcs.ts`), ⑦ web action hook (`apps/web/src/state/sourceControlActions.ts`).

---

## File Structure

| File                                                             | Responsibility                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/contracts/src/git.ts` _(modify)_                       | `VcsStagingArea` literal + optional `area` field; stage/unstage/discard inputs. |
| `packages/contracts/src/rpc.ts` _(modify)_                       | 3 `WS_METHODS` + 3 `Rpc.make` + add to `WsRpcGroup`.                            |
| `apps/server/src/ws.ts` _(modify)_                               | 3 scope entries + 3 dispatch handlers.                                          |
| `apps/server/src/vcs/GitVcsDriver.ts` _(modify)_                 | 3 service-interface methods.                                                    |
| `apps/server/src/vcs/GitVcsDriverCore.ts` _(modify)_             | Split numstat by area; implement stage/unstage/discard git calls.               |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` _(modify)_        | Area-split + staging integration tests.                                         |
| `apps/server/src/git/GitManager.ts` _(modify)_                   | Delegate stage/unstage/discard to the driver.                                   |
| `apps/server/src/git/GitWorkflowService.ts` _(modify)_           | Delegate stage/unstage/discard to `GitManager`.                                 |
| `packages/client-runtime/src/state/vcs.ts` _(modify)_            | 3 command atoms.                                                                |
| `apps/web/src/state/sourceControlActions.ts` _(modify)_          | `useVcsStageAction` / `useVcsUnstageAction` / `useVcsDiscardAction`.            |
| `apps/web/src/lib/sourceControlActions.ts` _(modify)_            | Re-export the 3 hooks.                                                          |
| `apps/web/src/components/SourceControlPanel.logic.ts` _(modify)_ | `groupFilesByArea` + `area` on `WorkingTreeFile`.                               |
| `apps/web/src/components/SourceControlSection.tsx` _(create)_    | Collapsible section header + list + bulk actions.                               |
| `apps/web/src/components/SourceControlPanel.tsx` _(modify)_      | Render sections; commit the staged set.                                         |

**Interfaces produced:**

- `VcsStagingArea = "staged" | "unstaged" | "untracked"`; `area?: VcsStagingArea` on each file entry.
- Inputs `VcsStageFilesInput` / `VcsUnstageFilesInput` / `VcsDiscardFilesInput` = `{ cwd: string; filePaths: readonly string[] }` (min length 1).
- `groupFilesByArea(files) → { staged: WorkingTreeFile[]; unstaged: WorkingTreeFile[]; untracked: WorkingTreeFile[] }`.

---

### Task 1: Contract — staging area + action inputs

**Files:**

- Modify: `packages/contracts/src/git.ts`

**Interfaces:**

- Produces: `VcsStagingArea`, `area?` field, and the three action inputs.

- [ ] **Step 1: Add the `VcsStagingArea` literal + `area` field**

`packages/contracts/src/git.ts` — after `VcsWorkingTreeFileStatus` (added in Plan 02) add:

```ts
export const VcsStagingArea = Schema.Literals(["staged", "unstaged", "untracked"]);
export type VcsStagingArea = typeof VcsStagingArea.Type;
```

Extend the `workingTree.files` struct (the one you edited in Plan 02) with:

```ts
        status: Schema.optional(VcsWorkingTreeFileStatus),
        area: Schema.optional(VcsStagingArea),
```

- [ ] **Step 2: Add the action inputs**

Near the other RPC inputs (e.g. after `VcsPullInput`, line 110):

```ts
export const VcsStageFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePaths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type VcsStageFilesInput = typeof VcsStageFilesInput.Type;

export const VcsUnstageFilesInput = VcsStageFilesInput;
export type VcsUnstageFilesInput = typeof VcsUnstageFilesInput.Type;

export const VcsDiscardFilesInput = VcsStageFilesInput;
export type VcsDiscardFilesInput = typeof VcsDiscardFilesInput.Type;
```

- [ ] **Step 3: Typecheck contracts + commit**

Run: `pnpm --filter @t3tools/contracts exec tsc --noEmit` → PASS.

```bash
git add packages/contracts/src/git.ts
git commit -m "feat(contracts): add staging area and stage/unstage/discard inputs"
```

---

### Task 2: Contract — register the three RPCs

**Files:**

- Modify: `packages/contracts/src/rpc.ts`

**Interfaces:**

- Produces: `WS_METHODS.vcsStageFiles` = `"vcs.stageFiles"`, `.vcsUnstageFiles` = `"vcs.unstageFiles"`, `.vcsDiscardFiles` = `"vcs.discardFiles"`; three `Rpc` definitions in `WsRpcGroup`.

- [ ] **Step 1: Add the method names**

In `WS_METHODS`, under the `// VCS methods` group (after `vcsInit`, line 172):

```ts
  vcsStageFiles: "vcs.stageFiles",
  vcsUnstageFiles: "vcs.unstageFiles",
  vcsDiscardFiles: "vcs.discardFiles",
```

- [ ] **Step 2: Import the inputs + add the Rpc definitions**

Add `VcsStageFilesInput, VcsUnstageFilesInput, VcsDiscardFilesInput` to the existing `./git.ts` import block at the top of `rpc.ts`. Then, after `WsVcsInitRpc` (line 468), add (these return void on success like `WsVcsRemoveWorktreeRpc`):

```ts
export const WsVcsStageFilesRpc = Rpc.make(WS_METHODS.vcsStageFiles, {
  payload: VcsStageFilesInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsUnstageFilesRpc = Rpc.make(WS_METHODS.vcsUnstageFiles, {
  payload: VcsUnstageFilesInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsDiscardFilesRpc = Rpc.make(WS_METHODS.vcsDiscardFiles, {
  payload: VcsDiscardFilesInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});
```

- [ ] **Step 3: Add them to `WsRpcGroup`**

In `RpcGroup.make(...)` (line 684+), after `WsVcsInitRpc` (line 720):

```ts
  WsVcsStageFilesRpc,
  WsVcsUnstageFilesRpc,
  WsVcsDiscardFilesRpc,
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @t3tools/contracts exec tsc --noEmit` → PASS.

```bash
git add packages/contracts/src/rpc.ts
git commit -m "feat(contracts): register stage/unstage/discard RPCs"
```

---

### Task 3: Server — driver + manager + workflow methods

**Files:**

- Modify: `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/git/GitManager.ts`, `apps/server/src/git/GitWorkflowService.ts`
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

**Interfaces:**

- Consumes: `executeGit`/`runGit` primitives already in `GitVcsDriverCore.ts`; `GitCommandError` from contracts.
- Produces: `stageFiles`/`unstageFiles`/`discardFiles` on `GitVcsDriver`, `GitManager`, and `GitWorkflowService`, all `(input: { cwd: string; filePaths: readonly string[] }) => Effect.Effect<void, GitCommandError>`. Plus `area` populated on every working-tree file.

- [ ] **Step 1: Write the failing integration test**

Add to `apps/server/src/vcs/GitVcsDriverCore.test.ts` (reuse the file's helpers `makeTmpDir`, `initRepoWithCommit`, `writeTextFile`, `git`):

```ts
it.effect("splits staged and unstaged changes into areas and stages selected files", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "tracked.ts", "export const a = 1;\n");
    yield* git(cwd, ["add", "tracked.ts"]);
    yield* git(cwd, ["commit", "-m", "add tracked"]);
    // one staged edit, one unstaged edit, one untracked file
    yield* writeTextFile(cwd, "tracked.ts", "export const a = 2;\n");
    yield* git(cwd, ["add", "tracked.ts"]);
    yield* writeTextFile(cwd, "tracked.ts", "export const a = 3;\n");
    yield* writeTextFile(cwd, "untracked.txt", "new\n");

    const driver = yield* GitVcsDriver.GitVcsDriver;
    const before = yield* driver.statusDetails(cwd);
    const areas = new Set(before.workingTree.files.map((file) => file.area));
    assert.isTrue(areas.has("staged"));
    assert.isTrue(areas.has("unstaged"));
    assert.isTrue(areas.has("untracked"));

    // stage the untracked file, then confirm it moves to the staged area
    yield* driver.stageFiles({ cwd, filePaths: ["untracked.txt"] });
    const after = yield* driver.statusDetails(cwd);
    const untrackedEntry = after.workingTree.files.find((file) => file.path === "untracked.txt");
    assert.equal(untrackedEntry?.area, "staged");
  }),
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts`
Expected: FAIL — `file.area` is `undefined`; `driver.stageFiles` does not exist.

- [ ] **Step 3: Split the numstat by area in `readStatusDetailsLocal`**

`apps/server/src/vcs/GitVcsDriverCore.ts` — replace the file-build block (Plan 02's version at lines ~1423-1446) so staged and unstaged numstat entries produce **separate** entries, and untracked files become area `"untracked"`:

```ts
const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);

let insertions = 0;
let deletions = 0;
const files: Array<{
  path: string;
  insertions: number;
  deletions: number;
  status: VcsWorkingTreeFileStatus;
  area: VcsStagingArea;
}> = [];

for (const entry of stagedEntries) {
  insertions += entry.insertions;
  deletions += entry.deletions;
  files.push({
    path: entry.path,
    insertions: entry.insertions,
    deletions: entry.deletions,
    status: statusByPath.get(entry.path) ?? "modified",
    area: "staged",
  });
}
for (const entry of unstagedEntries) {
  insertions += entry.insertions;
  deletions += entry.deletions;
  files.push({
    path: entry.path,
    insertions: entry.insertions,
    deletions: entry.deletions,
    status: statusByPath.get(entry.path) ?? "modified",
    area: "unstaged",
  });
}
// Untracked files have no numstat baseline; they were collected from the
// porcelain scan as area "untracked".
for (const filePath of changedFilesWithoutNumstat) {
  if (stagedEntries.some((entry) => entry.path === filePath)) continue;
  if (unstagedEntries.some((entry) => entry.path === filePath)) continue;
  files.push({
    path: filePath,
    insertions: 0,
    deletions: 0,
    status: statusByPath.get(filePath) ?? "modified",
    area: statusByPath.get(filePath) === "untracked" ? "untracked" : "unstaged",
  });
}
files.sort((a, b) => a.area.localeCompare(b.area) || a.path.localeCompare(b.path));
```

> This replaces the previous `fileStatMap` merge (which summed staged+unstaged into one entry). Remove the now-unused `fileStatMap` declaration. Totals (`insertions`/`deletions`) remain the sum across all areas — unchanged behavior for `workingTree.insertions/deletions`. Import `VcsStagingArea` (type) from `@t3tools/contracts` alongside `VcsWorkingTreeFileStatus`.

- [ ] **Step 4: Add the git primitives for staging**

Add three functions in the driver's service object (next to the other `executeGit`-based helpers, e.g. after the commit helper). Use the confirmed primitives:

```ts
const stageFiles: GitVcsDriver.GitVcsDriver["Service"]["stageFiles"] = Effect.fn("stageFiles")(
  function* (input) {
    yield* executeGit("GitVcsDriver.stageFiles", input.cwd, ["add", "--", ...input.filePaths]).pipe(
      Effect.asVoid,
    );
  },
);

const unstageFiles: GitVcsDriver.GitVcsDriver["Service"]["unstageFiles"] = Effect.fn(
  "unstageFiles",
)(function* (input) {
  yield* executeGit("GitVcsDriver.unstageFiles", input.cwd, [
    "restore",
    "--staged",
    "--",
    ...input.filePaths,
  ]).pipe(Effect.asVoid);
});

const discardFiles: GitVcsDriver.GitVcsDriver["Service"]["discardFiles"] = Effect.fn(
  "discardFiles",
)(function* (input) {
  // Tracked files: restore worktree + index from HEAD. Untracked files are
  // not affected by `restore`, so also `clean` them; `clean` ignores paths
  // that are tracked, so the two calls compose safely.
  yield* executeGit("GitVcsDriver.discardFiles.restore", input.cwd, [
    "restore",
    "--staged",
    "--worktree",
    "--",
    ...input.filePaths,
  ]).pipe(Effect.asVoid, Effect.ignore);
  yield* executeGit("GitVcsDriver.discardFiles.clean", input.cwd, [
    "clean",
    "-fd",
    "--",
    ...input.filePaths,
  ]).pipe(Effect.asVoid);
});
```

Add `stageFiles`, `unstageFiles`, `discardFiles` to the object returned by the driver layer (next to `statusDetailsLocal`, line ~2536).

- [ ] **Step 5: Declare the methods on the `GitVcsDriver` interface**

`apps/server/src/vcs/GitVcsDriver.ts` — in the `Service` interface (near `statusDetailsLocal`, line 197), add:

```ts
    readonly stageFiles: (input: {
      readonly cwd: string;
      readonly filePaths: readonly string[];
    }) => Effect.Effect<void, GitCommandError>;
    readonly unstageFiles: (input: {
      readonly cwd: string;
      readonly filePaths: readonly string[];
    }) => Effect.Effect<void, GitCommandError>;
    readonly discardFiles: (input: {
      readonly cwd: string;
      readonly filePaths: readonly string[];
    }) => Effect.Effect<void, GitCommandError>;
```

- [ ] **Step 6: Delegate through `GitManager` and `GitWorkflowService`**

`apps/server/src/git/GitManager.ts` — add three `Effect.fn` delegations that call the driver (mirror how `localStatus`/`status` obtain the driver via `gitCore`), and add them to the service interface (near line 69) and the returned object (near line 1862).

```ts
const stageFiles: GitManager["Service"]["stageFiles"] = Effect.fn("stageFiles")(function* (input) {
  yield* gitCore.stageFiles(input);
  yield* invalidateLocalStatusResultCache(input.cwd);
});
const unstageFiles: GitManager["Service"]["unstageFiles"] = Effect.fn("unstageFiles")(
  function* (input) {
    yield* gitCore.unstageFiles(input);
    yield* invalidateLocalStatusResultCache(input.cwd);
  },
);
const discardFiles: GitManager["Service"]["discardFiles"] = Effect.fn("discardFiles")(
  function* (input) {
    yield* gitCore.discardFiles(input);
    yield* invalidateLocalStatusResultCache(input.cwd);
  },
);
```

(Use the same `readonly stageFiles: (input: { cwd: string; filePaths: readonly string[] }) => Effect.Effect<void, GitCommandError>` signature on the `GitManager` interface, and add `stageFiles, unstageFiles, discardFiles` to its returned service object.)

`apps/server/src/git/GitWorkflowService.ts` — add the same three signatures to the `Context.Service` interface (near line 88) and delegate in the implementation (the impl object around line 259 wraps `gitManager` methods; add `stageFiles: (input) => gitManager.stageFiles(input)` etc.).

- [ ] **Step 7: Run the driver test to verify it passes; typecheck server**

Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts` → PASS.
Run: `pnpm --filter @t3tools/server exec tsc --noEmit` → PASS.

> The Plan 02 status test asserts `byPath.get("tracked.ts") === "modified"`. With the area split, a purely unstaged modification still yields one `"unstaged"` entry for `tracked.ts` — the assertion holds. If any existing server test asserted a unique-by-path `files` array, update it to account for two entries when a file is both staged and unstaged.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/git/GitManager.ts apps/server/src/git/GitWorkflowService.ts
git commit -m "feat(server): stage/unstage/discard git files and split status by area"
```

---

### Task 4: Server — dispatch + auth scopes

**Files:**

- Modify: `apps/server/src/ws.ts`

- [ ] **Step 1: Add auth scopes**

In the scope list (lines 309-312), add:

```ts
  [WS_METHODS.vcsStageFiles, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsUnstageFiles, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsDiscardFiles, AuthOrchestrationOperateScope],
```

- [ ] **Step 2: Add dispatch handlers**

In the dispatch map (after the `vcsPull` handler, line 1482), add (each mutation refreshes status so the client's subscription reflects the new areas — mirroring the `vcsPull` handler's `refreshGitStatus`):

```ts
        [WS_METHODS.vcsStageFiles]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsStageFiles,
            gitWorkflow
              .stageFiles(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true })))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsUnstageFiles]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsUnstageFiles,
            gitWorkflow
              .unstageFiles(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true })))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsDiscardFiles]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsDiscardFiles,
            gitWorkflow
              .discardFiles(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true })))),
            { "rpc.aggregate": "git" },
          ),
```

- [ ] **Step 3: Typecheck + a server boot smoke test**

Run: `pnpm --filter @t3tools/server exec tsc --noEmit` → PASS.
Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/server.test.ts` → PASS (this exercises the ws layer; every RPC in `WsRpcGroup` must have a scope + handler, so a missing wiring fails here).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/ws.ts
git commit -m "feat(server): dispatch stage/unstage/discard RPCs"
```

---

### Task 5: Client — command atoms + action hooks

**Files:**

- Modify: `packages/client-runtime/src/state/vcs.ts`, `apps/web/src/state/sourceControlActions.ts`, `apps/web/src/lib/sourceControlActions.ts`

**Interfaces:**

- Produces: `vcsEnvironment.stageFiles/unstageFiles/discardFiles` (commands); `useVcsStageAction(scope)` / `useVcsUnstageAction(scope)` / `useVcsDiscardAction(scope)` each returning `{ run(filePaths: string[]) , isPending, error }`.

- [ ] **Step 1: Add command atoms**

`packages/client-runtime/src/state/vcs.ts` — inside the returned object (after `init`, line 78):

```ts
    stageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:stage-files",
      tag: WS_METHODS.vcsStageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    unstageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:unstage-files",
      tag: WS_METHODS.vcsUnstageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    discardFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:discard-files",
      tag: WS_METHODS.vcsDiscardFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
```

- [ ] **Step 2: Add a failing hook test**

Create `apps/web/src/state/sourceControlActions.stage.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import {
  useVcsDiscardAction,
  useVcsStageAction,
  useVcsUnstageAction,
} from "./sourceControlActions";

describe("staging action hooks", () => {
  it("exports the three staging hooks", () => {
    expect(typeof useVcsStageAction).toBe("function");
    expect(typeof useVcsUnstageAction).toBe("function");
    expect(typeof useVcsDiscardAction).toBe("function");
  });
});
```

Run: `pnpm --filter @t3tools/web exec vp test run --project unit apps/web/src/state/sourceControlActions.stage.test.ts` → FAIL (not exported).

- [ ] **Step 3: Add the three hooks**

`apps/web/src/state/sourceControlActions.ts` — extend `SourceControlActionKind` and `ACTION_OPERATION`, then add three hooks modeled exactly on `useVcsPullAction` (they take `filePaths` as the run arg). First widen the kinds:

```ts
export type SourceControlActionKind =
  | "init"
  | "pull"
  | "publishRepository"
  | "runStackedAction"
  | "preparePullRequestThread"
  | "stageFiles"
  | "unstageFiles"
  | "discardFiles";
```

```ts
const ACTION_OPERATION = {
  init: "init",
  pull: "pull",
  publishRepository: "publish_repository",
  runStackedAction: "run_change_request",
  preparePullRequestThread: "prepare_pull_request_thread",
  stageFiles: "stage_files",
  unstageFiles: "unstage_files",
  discardFiles: "discard_files",
} as const satisfies Record<SourceControlActionKind, VcsActionOperation>;
```

> `VcsActionOperation` is a union in `@t3tools/client-runtime/state/vcs`. If `tsc` reports that `"stage_files"` / `"unstage_files"` / `"discard_files"` are not assignable, add them to the `VcsActionOperation` union at its definition (search `packages/client-runtime/src/state/vcsAction.ts` for `VcsActionOperation`). This is a one-line union extension.

Then add the hooks (after `useVcsPullAction`):

```ts
function useVcsFileAction(
  scope: SourceControlActionScope,
  kind: "stageFiles" | "unstageFiles" | "discardFiles",
  command: typeof vcsEnvironment.stageFiles,
  label: string,
) {
  const run = useAtomCommand(command, { reportFailure: false });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({ environmentId: scope.environmentId, input: { cwd: scope.cwd } })
      : null,
  );
  const action = useCallback(
    async (filePaths: string[]) => {
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: ACTION_OPERATION[kind],
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return run({ environmentId: target.environmentId, input: { cwd: target.cwd, filePaths } });
    },
    [run, scope, kind],
  );
  return useAction({ kind, label, scope, action, onSuccess: status.refresh });
}

export function useVcsStageAction(scope: SourceControlActionScope) {
  return useVcsFileAction(scope, "stageFiles", vcsEnvironment.stageFiles, "Staging files");
}
export function useVcsUnstageAction(scope: SourceControlActionScope) {
  return useVcsFileAction(scope, "unstageFiles", vcsEnvironment.unstageFiles, "Unstaging files");
}
export function useVcsDiscardAction(scope: SourceControlActionScope) {
  return useVcsFileAction(scope, "discardFiles", vcsEnvironment.discardFiles, "Discarding files");
}
```

- [ ] **Step 4: Re-export from the lib barrel**

`apps/web/src/lib/sourceControlActions.ts` — add `useVcsStageAction, useVcsUnstageAction, useVcsDiscardAction` to the re-export list.

- [ ] **Step 5: Run the hook test + typecheck; commit**

Run: `pnpm --filter @t3tools/web exec vp test run --project unit apps/web/src/state/sourceControlActions.stage.test.ts` → PASS.
Run: `pnpm --filter @t3tools/web exec tsgo --noEmit` → PASS.

```bash
git add packages/client-runtime/src/state/vcs.ts apps/web/src/state/sourceControlActions.ts apps/web/src/lib/sourceControlActions.ts apps/web/src/state/sourceControlActions.stage.test.ts
git commit -m "feat(source-control): add stage/unstage/discard client actions"
```

---

### Task 6: Client — group by area + section component

**Files:**

- Modify: `apps/web/src/components/SourceControlPanel.logic.ts`
- Test: `apps/web/src/components/SourceControlPanel.logic.test.ts`
- Create: `apps/web/src/components/SourceControlSection.tsx`

**Interfaces:**

- Produces: `groupFilesByArea(files) → { staged; unstaged; untracked }` and `SourceControlSection`.

- [ ] **Step 1: Write the failing grouping test**

Add to `apps/web/src/components/SourceControlPanel.logic.test.ts`:

```ts
import { groupFilesByArea } from "./SourceControlPanel.logic";

describe("groupFilesByArea", () => {
  it("buckets files by area, defaulting missing area to unstaged", () => {
    const groups = groupFilesByArea([
      { path: "a.ts", insertions: 1, deletions: 0, area: "staged" },
      { path: "b.ts", insertions: 2, deletions: 0, area: "unstaged" },
      { path: "c.txt", insertions: 0, deletions: 0, area: "untracked" },
      { path: "d.ts", insertions: 1, deletions: 1 },
    ]);
    expect(groups.staged.map((f) => f.path)).toEqual(["a.ts"]);
    expect(groups.unstaged.map((f) => f.path)).toEqual(["b.ts", "d.ts"]);
    expect(groups.untracked.map((f) => f.path)).toEqual(["c.txt"]);
  });
});
```

Run it → FAIL (`groupFilesByArea` undefined).

- [ ] **Step 2: Add `area` to `WorkingTreeFile` and implement `groupFilesByArea`**

`apps/web/src/components/SourceControlPanel.logic.ts` — extend the type + mapper and add the grouper:

```ts
import type { VcsStagingArea, VcsStatusResult, VcsWorkingTreeFileStatus } from "@t3tools/contracts";

export interface WorkingTreeFile {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly status?: VcsWorkingTreeFileStatus;
  readonly area?: VcsStagingArea;
}

export interface WorkingTreeGroups {
  readonly staged: WorkingTreeFile[];
  readonly unstaged: WorkingTreeFile[];
  readonly untracked: WorkingTreeFile[];
}

export function groupFilesByArea(files: readonly WorkingTreeFile[]): WorkingTreeGroups {
  const groups: WorkingTreeGroups = { staged: [], unstaged: [], untracked: [] };
  for (const file of files) {
    if (file.area === "staged") groups.staged.push(file);
    else if (file.area === "untracked") groups.untracked.push(file);
    else groups.unstaged.push(file);
  }
  return groups;
}
```

Update `workingTreeFiles` to also copy `area` (like `status`): `...(file.area ? { area: file.area } : {})`.

Run the logic test → PASS.

- [ ] **Step 3: Write the section component**

Create `apps/web/src/components/SourceControlSection.tsx`:

```tsx
import { ChevronDownIcon, MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { SourceControlChangesList } from "./SourceControlChangesList";
import { workingTreeStatusBadge } from "~/sourceControlStatus";
import type { WorkingTreeFile } from "./SourceControlPanel.logic";

interface SourceControlSectionProps {
  title: string;
  files: readonly WorkingTreeFile[];
  excludedPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  primaryAction?: { icon: "stage" | "unstage"; label: string; onClick: () => void };
  onDiscard?: () => void;
}

export function SourceControlSection(props: SourceControlSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  if (props.files.length === 0) return null;
  return (
    <div className="min-h-0">
      <div className="group flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex flex-1 items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", collapsed && "-rotate-90")}
          />
          {props.title}
          <span className="ml-1">{props.files.length}</span>
        </button>
        {props.primaryAction ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={props.primaryAction.label}
            onClick={props.primaryAction.onClick}
          >
            {props.primaryAction.icon === "stage" ? (
              <PlusIcon className="size-3.5" />
            ) : (
              <MinusIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
        {props.onDiscard ? (
          <Button variant="ghost" size="icon-xs" aria-label="Discard all" onClick={props.onDiscard}>
            <Undo2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {collapsed ? null : (
        <SourceControlChangesList
          files={props.files}
          excludedPaths={props.excludedPaths}
          onToggle={props.onToggle}
          onOpenFile={props.onOpenFile}
          renderBadge={(file) => {
            const badge = workingTreeStatusBadge(file.status);
            return (
              <span
                className={cn("w-4 shrink-0 text-center text-[10px] font-bold", badge.className)}
                title={badge.label}
              >
                {badge.letter}
              </span>
            );
          }}
        />
      )}
    </div>
  );
}
```

Run: `pnpm --filter @t3tools/web exec tsgo --noEmit` → PASS.

> If `size="icon-xs"` is not a valid `Button` size, use the token `GitActionsControl.tsx` uses (it calls `size="icon-xs"` at its dropdown trigger, so it is valid).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/SourceControlPanel.logic.ts apps/web/src/components/SourceControlPanel.logic.test.ts apps/web/src/components/SourceControlSection.tsx
git commit -m "feat(source-control): group changes by area and add section component"
```

---

### Task 7: Panel — render sections, stage/unstage/discard, commit staged set

**Files:**

- Modify: `apps/web/src/components/SourceControlPanel.tsx`

**Interfaces:**

- Consumes: `useVcsStageAction`/`useVcsUnstageAction`/`useVcsDiscardAction`, `groupFilesByArea`, `SourceControlSection`.

- [ ] **Step 1: Wire the staging actions + sections**

In `SourceControlPanel.tsx`:

1. Import: `import { groupFilesByArea } from "./SourceControlPanel.logic";`, `import { SourceControlSection } from "./SourceControlSection";`, and `useVcsStageAction, useVcsUnstageAction, useVcsDiscardAction` from `~/lib/sourceControlActions`.
2. Instantiate the actions:

```ts
const stageAction = useVcsStageAction(scope);
const unstageAction = useVcsUnstageAction(scope);
const discardAction = useVcsDiscardAction(scope);
```

3. Group the files: `const groups = useMemo(() => groupFilesByArea(files), [files]);`
4. Replace the single `<SourceControlChangesList .../>` (and its surrounding "Changes N" header + select-all row from Plan 01) with three sections inside the `ScrollArea`:

```tsx
            <SourceControlSection
              title="Staged Changes"
              files={groups.staged}
              excludedPaths={new Set()}
              onToggle={() => {}}
              onOpenFile={openFileInDiff}
              primaryAction={{
                icon: "unstage",
                label: "Unstage all",
                onClick: () => void unstageAction.run(groups.staged.map((f) => f.path)),
              }}
            />
            <SourceControlSection
              title="Changes"
              files={groups.unstaged}
              excludedPaths={new Set()}
              onToggle={() => {}}
              onOpenFile={openFileInDiff}
              primaryAction={{
                icon: "stage",
                label: "Stage all",
                onClick: () => void stageAction.run(groups.unstaged.map((f) => f.path)),
              }}
              onDiscard={() => void discardAction.run(groups.unstaged.map((f) => f.path))}
            />
            <SourceControlSection
              title="Untracked Files"
              files={groups.untracked}
              excludedPaths={new Set()}
              onToggle={() => {}}
              onOpenFile={openFileInDiff}
              primaryAction={{
                icon: "stage",
                label: "Stage all",
                onClick: () => void stageAction.run(groups.untracked.map((f) => f.path)),
              }}
              onDiscard={() => void discardAction.run(groups.untracked.map((f) => f.path))}
            />
```

> The `excludedPaths`/`onToggle` selection model from Plans 01–02 is superseded by real staging: only **staged** files are committed, so per-row checkboxes are no longer the selection mechanism. Pass an empty `excludedPaths` and a no-op `onToggle` (the `Checkbox` still renders; a follow-up may hide it — out of scope). The draft store's `excludedPaths` is now unused; leave it in place (harmless) or remove its usages from this component.

5. Change the commit to commit the **staged** set. Replace `resolveCommitFilePaths(summary)` usage in `runGitAction` with the staged paths:

```ts
const stagedPaths = groups.staged.map((file) => file.path);
const filePaths = stagedPaths.length > 0 ? stagedPaths : undefined;
```

and gate the primary Commit action on `groups.staged.length > 0` when the resolved action is a commit (extend `primaryDisabled`):

```ts
const requiresStaged =
  quickAction.kind === "run_action" && quickAction.action?.startsWith("commit");
const primaryDisabled =
  isBusy || quickAction.disabled || (requiresStaged && groups.staged.length === 0);
```

- [ ] **Step 2: Typecheck + web tests**

Run: `pnpm --filter @t3tools/web exec tsgo --noEmit` → PASS.
Run: `pnpm --filter @t3tools/web exec vp test run --project unit` → PASS.

- [ ] **Step 3: Manual verification**

`pnpm dev:web`, open the panel in a repo with staged + unstaged + untracked files:

1. Three sections appear with counts (`Staged Changes N`, `Changes N`, `Untracked Files N`) and the `U`/`M`/`A`/`D` badges from Plan 02.
2. `Stage all` on Changes/Untracked moves rows into Staged Changes; `Unstage all` reverses it; `Discard` on an unstaged/untracked file removes the change (confirm the file reverts).
3. Commit is disabled until something is staged; committing the staged set clears it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/SourceControlPanel.tsx
git commit -m "feat(source-control): render staged/unstaged/untracked sections with staging actions"
```

---

## Self-Review (Plan 03)

- **Spec coverage:** separate Staged / Changes / Untracked sections ✅; Stage All / Unstage / Discard ✅; commit-the-staged-set semantics ✅.
- **Placeholder scan:** contracts, RPC registration, client atoms/hooks and new components carry complete code; the server driver/manager/workflow method **bodies** use the confirmed `executeGit`/`gitCore` primitives with exact git commands; the few conditional notes (Button size token, `VcsActionOperation` union extension) each state the concrete fix.
- **Type consistency:** `VcsStagingArea` values match across contract, driver populate, and `groupFilesByArea`; the three hooks share the `useVcsFileAction(filePaths: string[])` signature; RPC names match the [00-overview.md](./00-overview.md) Shared Interfaces (`vcs.stageFiles`/`vcs.unstageFiles`/`vcs.discardFiles`).
- **Known limitations (documented):** commit stages whole files (partial-hunk staging is not modeled); discarding untracked files uses `git clean -fd`; clicking any row (including a **staged** one) opens the Diff surface at the `"unstaged"` working-tree scope — the same intentional behavior noted in Plan 01, not a regression. Per-file / per-area reveal remains a deferred enhancement.
