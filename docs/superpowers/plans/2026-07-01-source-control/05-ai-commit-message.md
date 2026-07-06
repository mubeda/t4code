# Plan 05 — AI Commit Message (✨ sparkle)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read [00-overview.md](./00-overview.md) first. **Depends on Plan 01** (the panel + draft store). Nicer after Plan 03 (generates from the staged set), but works after Plan 01 alone.

**Goal:** Add the ✨ sparkle button from the Orca screenshot: it generates a commit message from the current changes and writes it into the **editable** message box (the user can review/edit before committing), with a client-side cancel.

**Architecture:** The server already generates commit messages inside the stacked-commit action via `textGeneration.generateCommitMessage(...)`, resolving the model from server settings (`serverSettingsService.getSettings().textGenerationModelSelection`, GitManager.ts:1734). This plan exposes that as a standalone operate RPC `vcs.generateCommitMessage` that returns the message **without committing and without mutating the git index**. It deliberately does **not** reuse `resolveCommitAndBranchSuggestion` (whose `prepareCommitContext` runs `git reset` + `git add` — see the note below); instead it adds a **read-only** context builder that summarizes the diff via `git diff`. On the client, a `useVcsGenerateCommitMessageAction` hook drives a sparkle button that fills the Plan-01 draft store's `message`.

**Tech Stack:** Effect `Schema`/`RpcGroup` (contracts), Effect + existing text-generation service (server), React (client). Tests: `vite-plus/test`; server `it.effect`.

## Global Constraints

See [00-overview.md → Global Constraints](./00-overview.md#global-constraints) and the **RPC registration checklist** in [03-staged-unstaged-index.md](./03-staged-unstaged-index.md#global-constraints). `vcs.generateCommitMessage` performs model work (spends tokens) but does **not** mutate the repo history; register it with `AuthOrchestrationOperateScope` (consistent with `gitRunStackedAction`, which also generates).

> **Why a read-only context (do not skip):** the existing `gitCore.prepareCommitContext(cwd, filePaths)` **mutates the index** — it runs `git reset` (unstaging everything) then `git add -- <paths>` (GitVcsDriverCore.ts ~1521-1533). Reusing it for a _preview_ button would mean clicking ✨ with nothing staged silently stages the entire working tree. This plan therefore builds the diff context read-only with `git diff` (Task 2) and never stages. Untracked files are not visible to `git diff HEAD`, so a repository whose only changes are brand-new files yields an empty context and the button reports "no changes to summarize" — an accepted limitation of a non-mutating preview.

---

## File Structure

| File                                                        | Responsibility                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/contracts/src/git.ts` _(modify)_                  | `VcsGenerateCommitMessageInput` / `VcsGenerateCommitMessageResult`. |
| `packages/contracts/src/rpc.ts` _(modify)_                  | `WS_METHODS.vcsGenerateCommitMessage` + `Rpc.make` + `WsRpcGroup`.  |
| `apps/server/src/ws.ts` _(modify)_                          | operate scope + dispatch.                                           |
| `apps/server/src/vcs/GitVcsDriver.ts` _(modify)_            | `readCommitMessageContext` interface method.                        |
| `apps/server/src/vcs/GitVcsDriverCore.ts` _(modify)_        | read-only diff context builder (no index mutation).                 |
| `apps/server/src/git/GitManager.ts` _(modify)_              | `generateCommitMessage` service method.                             |
| `apps/server/src/git/GitManager.test.ts` _(modify)_         | test the new method.                                                |
| `apps/server/src/git/GitWorkflowService.ts` _(modify)_      | delegate `generateCommitMessage`.                                   |
| `packages/client-runtime/src/state/vcs.ts` _(modify)_       | command atom.                                                       |
| `apps/web/src/state/sourceControlActions.ts` _(modify)_     | `useVcsGenerateCommitMessageAction`.                                |
| `apps/web/src/lib/sourceControlActions.ts` _(modify)_       | re-export the hook.                                                 |
| `apps/web/src/components/SourceControlPanel.tsx` _(modify)_ | sparkle button + cancel + fill message.                             |

**Interfaces produced:**

- `VcsGenerateCommitMessageInput = { cwd: string; filePaths?: readonly string[] }` (no `modelSelection` — the server resolves it).
- `VcsGenerateCommitMessageResult = { message: string }`.
- `useVcsGenerateCommitMessageAction(scope) → { run(input: { filePaths?: string[] }), isPending, error }`.

---

### Task 1: Contract + RPC registration

**Files:**

- Modify: `packages/contracts/src/git.ts`, `packages/contracts/src/rpc.ts`

- [ ] **Step 1: Schemas** (`git.ts`)

```ts
export const VcsGenerateCommitMessageInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePaths: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
});
export type VcsGenerateCommitMessageInput = typeof VcsGenerateCommitMessageInput.Type;

export const VcsGenerateCommitMessageResult = Schema.Struct({
  message: Schema.String,
});
export type VcsGenerateCommitMessageResult = typeof VcsGenerateCommitMessageResult.Type;
```

- [ ] **Step 2: Register the RPC** (`rpc.ts`): add `vcsGenerateCommitMessage: "vcs.generateCommitMessage"` to `WS_METHODS`; import the two types; add (error `GitManagerServiceError` — its union already includes `TextGenerationError`):

```ts
export const WsVcsGenerateCommitMessageRpc = Rpc.make(WS_METHODS.vcsGenerateCommitMessage, {
  payload: VcsGenerateCommitMessageInput,
  success: VcsGenerateCommitMessageResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});
```

and add `WsVcsGenerateCommitMessageRpc` to `WsRpcGroup`.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm --filter @t3tools/contracts exec tsc --noEmit` → PASS.

```bash
git add packages/contracts/src/git.ts packages/contracts/src/rpc.ts
git commit -m "feat(contracts): add vcs.generateCommitMessage RPC"
```

---

### Task 2: Server — expose `generateCommitMessage`

**Files:**

- Modify: `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/git/GitManager.ts`, `apps/server/src/git/GitWorkflowService.ts`
- Test: `apps/server/src/git/GitManager.test.ts`

**Interfaces:**

- Produces: `readCommitMessageContext(cwd, filePaths?) → Effect<{ hasChanges: boolean; summary: string; patch: string }, GitCommandError>` on `GitVcsDriver`; `generateCommitMessage(input: VcsGenerateCommitMessageInput) → Effect<VcsGenerateCommitMessageResult, GitManagerServiceError>` on `GitManager` and `GitWorkflowService`.

- [ ] **Step 1: Failing test** (`GitManager.test.ts`)

`GitManager.test.ts` already builds a `GitManager` with a stubbed `textGeneration` service. Add a test that stubs `generateCommitMessage` to return a fixed subject/body and asserts the service formats it. Follow the file's existing harness (search for how `textGeneration` is provided in this test):

```ts
it.effect("generateCommitMessage returns a formatted message for staged changes", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

    const manager = yield* GitManager.GitManager;
    const result = yield* manager.generateCommitMessage({ cwd });
    // The stubbed textGeneration returns subject "test subject" (see harness).
    assert.include(result.message, "test subject");
  }),
);
```

> Match the exact stub the existing `GitManager.test.ts` uses for `textGeneration.generateCommitMessage`; if the harness returns a different fixed subject, assert on that. If the test file has no `textGeneration` stub yet, add one mirroring the real `TextGenerationService` shape (a single `generateCommitMessage` returning `{ subject, body }`).

Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/git/GitManager.test.ts` → FAIL (`manager.generateCommitMessage` missing).

- [ ] **Step 2: Add the read-only diff context builder** (`GitVcsDriverCore.ts`)

Add a driver method that summarizes the diff **without staging** — prefer the already-staged diff, else the full working-tree diff against `HEAD`. Use the confirmed `runGitStdout` / `runGitStdoutWithOptions` primitives (both defined in this file). Place it near `readStatusDetailsLocal`:

```ts
const readCommitMessageContext: GitVcsDriver.GitVcsDriver["Service"]["readCommitMessageContext"] =
  Effect.fn("readCommitMessageContext")(function* (cwd, filePaths) {
    const pathArgs = filePaths && filePaths.length > 0 ? ["--", ...filePaths] : [];
    const stagedSummary = yield* runGitStdout(
      "GitVcsDriver.commitMessageContext.stagedSummary",
      cwd,
      ["diff", "--cached", "--name-status", ...pathArgs],
    );
    if (stagedSummary.trim().length > 0) {
      const patch = yield* runGitStdout("GitVcsDriver.commitMessageContext.stagedPatch", cwd, [
        "diff",
        "--cached",
        "--no-color",
        ...pathArgs,
      ]);
      return { hasChanges: true, summary: stagedSummary, patch };
    }
    const worktreeSummary = yield* runGitStdout(
      "GitVcsDriver.commitMessageContext.worktreeSummary",
      cwd,
      ["diff", "HEAD", "--name-status", ...pathArgs],
    );
    if (worktreeSummary.trim().length === 0) {
      return { hasChanges: false, summary: "", patch: "" };
    }
    const worktreePatch = yield* runGitStdout(
      "GitVcsDriver.commitMessageContext.worktreePatch",
      cwd,
      ["diff", "HEAD", "--no-color", ...pathArgs],
    );
    return { hasChanges: true, summary: worktreeSummary, patch: worktreePatch };
  });
```

Add `readCommitMessageContext` to the returned driver object, and declare it on the `GitVcsDriver` `Service` interface (`GitVcsDriver.ts`, near `statusDetailsLocal`):

```ts
    readonly readCommitMessageContext: (
      cwd: string,
      filePaths?: readonly string[],
    ) => Effect.Effect<
      { readonly hasChanges: boolean; readonly summary: string; readonly patch: string },
      GitCommandError
    >;
```

- [ ] **Step 3: Implement the manager service method** (`GitManager.ts`)

Add (inside the same `Effect.gen` scope as `textGeneration`, `serverSettingsService`, and the private helpers `sanitizeCommitMessage` / `formatCommitMessage` — e.g. just after `resolveCommitAndBranchSuggestion`, line 1184). It calls `textGeneration.generateCommitMessage` directly on the **read-only** context, never mutating the index:

```ts
const generateCommitMessage: GitManager["Service"]["generateCommitMessage"] = Effect.fn(
  "generateCommitMessage",
)(function* (input) {
  const details = yield* gitCore.statusDetails(input.cwd);
  const context = yield* gitCore.readCommitMessageContext(input.cwd, input.filePaths);
  if (!context.hasChanges) {
    return { message: "" };
  }
  const modelSelection = yield* serverSettingsService.getSettings.pipe(
    Effect.map((settings) => settings.textGenerationModelSelection),
  );
  const generated = yield* textGeneration
    .generateCommitMessage({
      cwd: input.cwd,
      branch: details.branch,
      stagedSummary: limitContext(context.summary, 8_000),
      stagedPatch: limitContext(context.patch, 50_000),
      modelSelection,
    })
    .pipe(Effect.map((result) => sanitizeCommitMessage(result)));
  return { message: formatCommitMessage(generated.subject, generated.body) };
});
```

(`limitContext`, `sanitizeCommitMessage`, `formatCommitMessage` are the same private helpers `resolveCommitAndBranchSuggestion` uses at lines 1170-1181, in scope here.) Declare the method on the `GitManager` `Service` interface (near line 69) and add it to the returned service object (near line 1862). Import `VcsGenerateCommitMessageInput`, `VcsGenerateCommitMessageResult` from `@t3tools/contracts`:

```ts
    readonly generateCommitMessage: (
      input: VcsGenerateCommitMessageInput,
    ) => Effect.Effect<VcsGenerateCommitMessageResult, GitManagerServiceError>;
```

- [ ] **Step 4: Delegate from `GitWorkflowService`** — add the same signature to its interface (near line 61) and `generateCommitMessage: (input) => gitManager.generateCommitMessage(input)` to the impl.

- [ ] **Step 5: Run test + typecheck + commit**

Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/git/GitManager.test.ts` → PASS.
Run: `pnpm --filter @t3tools/server exec tsc --noEmit` → PASS.

```bash
git add apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/git/GitManager.ts apps/server/src/git/GitManager.test.ts apps/server/src/git/GitWorkflowService.ts
git commit -m "feat(server): expose non-mutating generate-commit-message"
```

---

### Task 3: Server — dispatch + scope

**Files:**

- Modify: `apps/server/src/ws.ts`

- [ ] **Step 1: Scope + handler**

Scope list (line 309): `[WS_METHODS.vcsGenerateCommitMessage, AuthOrchestrationOperateScope],`

Dispatch (near the `gitRunStackedAction` handler, line 1483):

```ts
        [WS_METHODS.vcsGenerateCommitMessage]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsGenerateCommitMessage,
            gitWorkflow.generateCommitMessage(input),
            { "rpc.aggregate": "git" },
          ),
```

- [ ] **Step 2: Typecheck + server test + commit**

Run: `pnpm --filter @t3tools/server exec tsc --noEmit` → PASS.
Run: `pnpm --filter @t3tools/server exec vp test run apps/server/src/server.test.ts` → PASS.

```bash
git add apps/server/src/ws.ts
git commit -m "feat(server): dispatch vcs.generateCommitMessage"
```

---

### Task 4: Client — hook + sparkle button

**Files:**

- Modify: `packages/client-runtime/src/state/vcs.ts`, `apps/web/src/state/sourceControlActions.ts`, `apps/web/src/lib/sourceControlActions.ts`, `apps/web/src/components/SourceControlPanel.tsx`

**Interfaces:**

- Produces: `vcsEnvironment.generateCommitMessage` command; `useVcsGenerateCommitMessageAction(scope)`.

- [ ] **Step 1: Command atom** (`packages/client-runtime/src/state/vcs.ts`, after `init`)

```ts
    generateCommitMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:generate-commit-message",
      tag: WS_METHODS.vcsGenerateCommitMessage,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
```

- [ ] **Step 2: Failing hook test** (`apps/web/src/state/sourceControlActions.generate.test.ts`)

```ts
import { describe, expect, it } from "vite-plus/test";

import { useVcsGenerateCommitMessageAction } from "./sourceControlActions";

describe("useVcsGenerateCommitMessageAction", () => {
  it("is exported", () => {
    expect(typeof useVcsGenerateCommitMessageAction).toBe("function");
  });
});
```

Run → FAIL.

- [ ] **Step 3: Add the hook** (`apps/web/src/state/sourceControlActions.ts`)

Extend `SourceControlActionKind` with `"generateCommitMessage"` and `ACTION_OPERATION` with `generateCommitMessage: "generate_commit_message"` (add `"generate_commit_message"` to the `VcsActionOperation` union in `packages/client-runtime/src/state/vcsAction.ts` if `tsc` flags it — one-line extension, same as Plan 03). Then:

```ts
export function useVcsGenerateCommitMessageAction(scope: SourceControlActionScope) {
  const generate = useAtomCommand(vcsEnvironment.generateCommitMessage, { reportFailure: false });
  const action = useCallback(
    async (input: { filePaths?: string[] }) => {
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "generate_commit_message",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return generate({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
        },
      });
    },
    [generate, scope],
  );
  return useAction({
    kind: "generateCommitMessage",
    label: "Generating commit message",
    scope,
    action,
  });
}
```

- [ ] **Step 4: Re-export** (`apps/web/src/lib/sourceControlActions.ts`): add `useVcsGenerateCommitMessageAction`.

Run: `pnpm --filter @t3tools/web exec vp test run --project unit apps/web/src/state/sourceControlActions.generate.test.ts` → PASS.

- [ ] **Step 5: Sparkle button + cancel in the panel** (`SourceControlPanel.tsx`)

1. Imports: `import { SparklesIcon, SquareIcon } from "lucide-react";` (add to the existing lucide import), `import { useVcsGenerateCommitMessageAction } from "~/lib/sourceControlActions";`, `import { useRef } from "react";` (extend the existing react import).
2. Instantiate: `const generateAction = useVcsGenerateCommitMessageAction(scope);` and a cancel guard: `const generationTokenRef = useRef(0);`
3. Compute the paths to scope the (read-only) diff to — staged if present, else all changed paths. This only narrows which files the server diffs; it never stages anything (Task 2 is non-mutating):

```ts
const generateFilePaths = useMemo(() => {
  const staged = files.filter((file) => file.area === "staged").map((file) => file.path);
  return staged.length > 0 ? staged : files.map((file) => file.path);
}, [files]);
```

4. The handler (fills the draft message unless canceled):

```ts
const onGenerate = useCallback(async () => {
  const token = generationTokenRef.current + 1;
  generationTokenRef.current = token;
  const result = await generateAction.run({ filePaths: generateFilePaths });
  if (generationTokenRef.current !== token) return; // canceled/superseded
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not generate a commit message",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      }),
    );
    return;
  }
  if (result.value.message.trim().length > 0) {
    setMessage(threadRef, result.value.message);
  }
}, [generateAction, generateFilePaths, setMessage, threadRef, threadToastData]);

const cancelGenerate = useCallback(() => {
  generationTokenRef.current += 1; // ignore the in-flight result
}, []);
```

5. Render the button in the message box's top-right. Replace the plain `<Textarea .../>` from Plan 01 with a positioned wrapper:

```tsx
<div className="relative">
  <Textarea
    value={draft.message}
    onChange={(event) => setMessage(threadRef, event.target.value)}
    placeholder="Message (leave empty to auto-generate)"
    size="sm"
    aria-label="Commit message"
    className="pr-9"
  />
  <button
    type="button"
    onClick={() => (generateAction.isPending ? cancelGenerate() : void onGenerate())}
    disabled={files.length === 0 && !generateAction.isPending}
    aria-label={generateAction.isPending ? "Stop generating" : "Generate commit message with AI"}
    title={generateAction.isPending ? "Stop" : "Generate commit message with AI"}
    className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
  >
    {generateAction.isPending ? (
      <SquareIcon className="size-3.5" />
    ) : (
      <SparklesIcon className="size-3.5" />
    )}
  </button>
</div>
```

- [ ] **Step 6: Typecheck + web tests + manual + commit**

Run: `pnpm --filter @t3tools/web exec tsgo --noEmit` → PASS.
Run: `pnpm --filter @t3tools/web exec vp test run --project unit` → PASS.
Manual: `pnpm dev:web`, open the panel in a dirty repo, click ✨ → a spinner/stop icon shows while generating, then the message box fills with a generated message you can edit; clicking stop mid-flight leaves the box untouched.

```bash
git add packages/client-runtime/src/state/vcs.ts apps/web/src/state/sourceControlActions.ts apps/web/src/lib/sourceControlActions.ts apps/web/src/state/sourceControlActions.generate.test.ts apps/web/src/components/SourceControlPanel.tsx
git commit -m "feat(source-control): AI-generate an editable commit message"
```

---

## Self-Review (Plan 05)

- **Spec coverage:** the ✨ sparkle that fills an **editable** commit-message box ✅; client-side cancel ✅.
- **Placeholder scan:** complete code; the one harness-dependent note (the existing `textGeneration` stub subject in `GitManager.test.ts`) has a concrete instruction. The server method reuses the confirmed `resolveCommitAndBranchSuggestion` + `serverSettingsService` (GitManager.ts:1734) rather than inventing generation logic.
- **Type consistency:** `VcsGenerateCommitMessageInput/Result` match across contract, server method, and client hook; RPC name `vcs.generateCommitMessage` and hook name match [00-overview.md](./00-overview.md). No `modelSelection` on the wire — resolved server-side, as verified in the existing stacked-action path.
- **Non-mutating by design:** generation uses a read-only `git diff` context (Task 2) and never touches the index, so clicking ✨ never changes the user's staging. Documented limitation: a repo whose only changes are brand-new untracked files produces an empty context (invisible to `git diff HEAD`).
