# Plan 01 — Source Control Surface + Core Panel

> Status: archival. This shipped plan preserves its original paths and commands.
> Use [Current Scripts](../../../reference/scripts.md) for supported commands.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read [00-overview.md](./00-overview.md) first — its **Global Constraints** and **Shared Interfaces & Naming** apply to every task here.

**Goal:** Add a "Source Control" card to the right-panel "Open a surface" chooser and a persistent `SourceControlPanel` that lists working-tree changes with `+/-` counts, lets the user select a subset ("staging"), edit a commit message, and run Commit / Push / Create-PR via the existing streaming git action — all by composing APIs that already exist. No backend changes.

**Architecture:** A new singleton surface kind `"sourceControl"` in `rightPanelStore`, wired through `RightPanelTabs` (chooser card, `+` menu, tab title/icon) and `ChatView` (add-callback, availability gate, content branch). The panel subscribes to `vcsEnvironment.status(...)` for the changed-files list + branch/PR context and calls `useGitStackedAction(scope).run(...)` for actions, reusing the pure decision helpers in `GitActionsControl.logic.ts`. A small `sourceControlPanelStore` persists the per-thread commit-message draft and excluded-file set.

**Tech Stack:** React 19, zustand 5 + persist, `@effect/atom-react`, Tailwind 4, `@base-ui/react`, lucide-react. Tests via `vite-plus/test`.

## Global Constraints

See [00-overview.md → Global Constraints](./00-overview.md#global-constraints). Highlights: test imports from `vite-plus/test`; component render-tests use `renderToStaticMarkup`; `~/` = `apps/web/src/`; no new dependencies; provider-aware terminology via `getSourceControlPresentation`.

---

## File Structure

| File                                                                   | Responsibility                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web/src/rightPanelStore.ts` _(modify)_                           | Register the `sourceControl` surface kind, union member, singleton factory, storage version bump. |
| `apps/web/src/sourceControlPanelStore.ts` _(create)_                   | Thread-scoped persisted draft: commit message + excluded-file paths.                              |
| `apps/web/src/sourceControlPanelStore.test.ts` _(create)_              | Store unit tests.                                                                                 |
| `apps/web/src/components/SourceControlPanel.logic.ts` _(create)_       | Pure helpers: path split, selection summary, commit filePaths.                                    |
| `apps/web/src/components/SourceControlPanel.logic.test.ts` _(create)_  | Logic unit tests.                                                                                 |
| `apps/web/src/components/SourceControlChangesList.tsx` _(create)_      | Presentational changed-files list (render-testable).                                              |
| `apps/web/src/components/SourceControlChangesList.test.tsx` _(create)_ | Render test.                                                                                      |
| `apps/web/src/components/SourceControlPanel.tsx` _(create)_            | The composed panel (default export).                                                              |
| `apps/web/src/components/RightPanelTabs.tsx` _(modify)_                | Chooser card, `+` menu item, tab title/icon, disabled reason, new props.                          |
| `apps/web/src/components/ChatView.tsx` _(modify)_                      | `addSourceControlSurface`, availability, content branch, render-site props.                       |

**Interfaces produced by this plan (consumed by later plans):**

- `SourceControlPanel` default export, props `{ mode: DiffPanelMode; threadRef: ScopedThreadRef; gitCwd: string | null }`.
- `useSourceControlPanelStore` + `selectThreadSourceControlDraft(byThreadKey, ref) → SourceControlDraft` where `SourceControlDraft = { message: string; excludedPaths: string[] }`.
- `SourceControlChangesList` props include an optional `renderBadge?: (file: WorkingTreeFile) => ReactNode` slot (Plan 02 injects the status badge here) and an optional `renderSections` extension point is **not** added here — Plan 03 refactors the list into sections.
- `summarizeChangeSelection`, `resolveCommitFilePaths`, `splitFilePath`, `workingTreeFiles`, `type WorkingTreeFile` from `SourceControlPanel.logic.ts`.

---

### Task 1: Register the `sourceControl` surface kind

**Files:**

- Modify: `apps/web/src/rightPanelStore.ts` (lines 17, 20-40, 43, 85-96)
- Test: `apps/web/src/rightPanelStore.test.ts` (existing file — add a case)

**Interfaces:**

- Produces: surface descriptor `{ id: "sourceControl"; kind: "sourceControl" }`; `useRightPanelStore.getState().open(ref, "sourceControl")` opens/activates it.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/rightPanelStore.test.ts` (follow the existing describe/beforeEach in that file; it already imports `useRightPanelStore` and a `THREAD_REF`-style ref via `scopeThreadRef`):

```ts
it("opens a singleton source control surface", () => {
  useRightPanelStore.getState().open(THREAD_REF, "sourceControl");
  const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF);
  expect(state.surfaces).toContainEqual({ id: "sourceControl", kind: "sourceControl" });
  expect(state.activeSurfaceId).toBe("sourceControl");
  expect(state.isOpen).toBe(true);
});
```

> If `THREAD_REF` / `selectThreadRightPanelState` are not already imported at the top of the existing test file, add them: `import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";` and reuse the file's existing `THREAD_REF` constant.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/rightPanelStore.test.ts`
Expected: FAIL — TypeScript rejects `"sourceControl"` as an argument to `open` (not in `RIGHT_PANEL_KINDS`), or the surface is never added.

- [ ] **Step 3: Add the kind to `RIGHT_PANEL_KINDS`**

`apps/web/src/rightPanelStore.ts` line 17:

```ts
export const RIGHT_PANEL_KINDS = [
  "plan",
  "diff",
  "sourceControl",
  "files",
  "file",
  "preview",
  "terminal",
] as const;
```

- [ ] **Step 4: Add the union member**

`apps/web/src/rightPanelStore.ts` — inside the `RightPanelSurface` union (after the `{ id: "diff"; kind: "diff" }` member, line 31):

```ts
  | { id: "sourceControl"; kind: "sourceControl" }
```

- [ ] **Step 5: Add the singleton factory case**

`apps/web/src/rightPanelStore.ts` — in `singletonSurface` (lines 85-96), add a case:

```ts
    case "sourceControl":
      return { id: "sourceControl", kind };
```

- [ ] **Step 6: Bump the storage version**

`apps/web/src/rightPanelStore.ts` line 43:

```ts
const RIGHT_PANEL_STORAGE_VERSION = 8;
```

(The `migratePersistedRightPanelState` default branch at line 187, `return [surface];`, already passes an unknown singleton surface through unchanged — no migration code is needed.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/rightPanelStore.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/rightPanelStore.ts apps/web/src/rightPanelStore.test.ts
git commit -m "feat(source-control): register sourceControl right-panel surface kind"
```

---

### Task 2: Draft store (`sourceControlPanelStore`)

**Files:**

- Create: `apps/web/src/sourceControlPanelStore.ts`
- Test: `apps/web/src/sourceControlPanelStore.test.ts`

**Interfaces:**

- Produces: `useSourceControlPanelStore` with actions `setMessage`, `toggleExcludedPath`, `setExcludedPaths`, `clearDraft`, `removeThread`; selector `selectThreadSourceControlDraft(byThreadKey, ref) → SourceControlDraft`; type `SourceControlDraft = { message: string; excludedPaths: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/sourceControlPanelStore.test.ts`:

```ts
import { scopeThreadRef } from "@t4code/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t4code/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadSourceControlDraft,
  useSourceControlPanelStore,
} from "./sourceControlPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("sourceControlPanelStore", () => {
  beforeEach(() => useSourceControlPanelStore.setState({ byThreadKey: {} }));

  it("returns a default draft for an unknown thread", () => {
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      message: "",
      excludedPaths: [],
    });
  });

  it("sets the commit message", () => {
    useSourceControlPanelStore.getState().setMessage(THREAD_REF, "fix: thing");
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF)
        .message,
    ).toBe("fix: thing");
  });

  it("toggles an excluded path on and off", () => {
    useSourceControlPanelStore.getState().toggleExcludedPath(THREAD_REF, "src/a.ts");
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF)
        .excludedPaths,
    ).toEqual(["src/a.ts"]);
    useSourceControlPanelStore.getState().toggleExcludedPath(THREAD_REF, "src/a.ts");
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF)
        .excludedPaths,
    ).toEqual([]);
  });

  it("clears the draft on removeThread", () => {
    useSourceControlPanelStore.getState().setMessage(THREAD_REF, "wip");
    useSourceControlPanelStore.getState().removeThread(THREAD_REF);
    expect(useSourceControlPanelStore.getState().byThreadKey).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/sourceControlPanelStore.test.ts`
Expected: FAIL — module `./sourceControlPanelStore` does not exist.

- [ ] **Step 3: Write the store**

Create `apps/web/src/sourceControlPanelStore.ts`:

```ts
import { scopedThreadKey } from "@t4code/client-runtime/environment";
import type { ScopedThreadRef } from "@t4code/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface SourceControlDraft {
  message: string;
  excludedPaths: string[];
}

const DEFAULT_DRAFT: SourceControlDraft = { message: "", excludedPaths: [] };

interface SourceControlPanelStoreState {
  byThreadKey: Record<string, SourceControlDraft>;
  setMessage: (ref: ScopedThreadRef, message: string) => void;
  toggleExcludedPath: (ref: ScopedThreadRef, path: string) => void;
  setExcludedPaths: (ref: ScopedThreadRef, paths: readonly string[]) => void;
  clearDraft: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function updateDraft(
  state: SourceControlPanelStoreState,
  ref: ScopedThreadRef,
  updater: (draft: SourceControlDraft) => SourceControlDraft,
): { byThreadKey: Record<string, SourceControlDraft> } {
  const key = scopedThreadKey(ref);
  const previous = state.byThreadKey[key] ?? DEFAULT_DRAFT;
  return { byThreadKey: { ...state.byThreadKey, [key]: updater(previous) } };
}

export const useSourceControlPanelStore = create<SourceControlPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      setMessage: (ref, message) =>
        set((state) => updateDraft(state, ref, (draft) => ({ ...draft, message }))),
      toggleExcludedPath: (ref, path) =>
        set((state) =>
          updateDraft(state, ref, (draft) => {
            const next = new Set(draft.excludedPaths);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return { ...draft, excludedPaths: [...next] };
          }),
        ),
      setExcludedPaths: (ref, paths) =>
        set((state) =>
          updateDraft(state, ref, (draft) => ({ ...draft, excludedPaths: [...new Set(paths)] })),
        ),
      clearDraft: (ref) => set((state) => updateDraft(state, ref, () => ({ ...DEFAULT_DRAFT }))),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t4code:source-control-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function selectThreadSourceControlDraft(
  byThreadKey: Record<string, SourceControlDraft>,
  ref: ScopedThreadRef | null | undefined,
): SourceControlDraft {
  if (!ref) return DEFAULT_DRAFT;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_DRAFT;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/sourceControlPanelStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/sourceControlPanelStore.ts apps/web/src/sourceControlPanelStore.test.ts
git commit -m "feat(source-control): add source control panel draft store"
```

---

### Task 3: Panel logic module

**Files:**

- Create: `apps/web/src/components/SourceControlPanel.logic.ts`
- Test: `apps/web/src/components/SourceControlPanel.logic.test.ts`

**Interfaces:**

- Consumes: `VcsStatusResult` from `@t4code/contracts`.
- Produces: `type WorkingTreeFile = { path: string; insertions: number; deletions: number }`; `splitFilePath(path) → { dir: string | null; name: string }`; `summarizeChangeSelection(files, excludedPaths) → ChangeSelectionSummary`; `resolveCommitFilePaths(summary) → string[] | undefined`; `workingTreeFiles(status) → WorkingTreeFile[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/SourceControlPanel.logic.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import {
  resolveCommitFilePaths,
  splitFilePath,
  summarizeChangeSelection,
  type WorkingTreeFile,
} from "./SourceControlPanel.logic";

const FILES: WorkingTreeFile[] = [
  { path: "docs/prps/PFS-1848/master-plan.md", insertions: 218, deletions: 0 },
  { path: "tasks.md", insertions: 139, deletions: 4 },
];

describe("splitFilePath", () => {
  it("splits a nested path into dir and name", () => {
    expect(splitFilePath("docs/prps/PFS-1848/master-plan.md")).toEqual({
      dir: "docs/prps/PFS-1848",
      name: "master-plan.md",
    });
  });

  it("returns a null dir for a top-level file", () => {
    expect(splitFilePath("tasks.md")).toEqual({ dir: null, name: "tasks.md" });
  });
});

describe("summarizeChangeSelection", () => {
  it("counts all files when nothing is excluded", () => {
    const summary = summarizeChangeSelection(FILES, new Set());
    expect(summary.allSelected).toBe(true);
    expect(summary.noneSelected).toBe(false);
    expect(summary.selectedCount).toBe(2);
    expect(summary.insertions).toBe(357);
    expect(summary.deletions).toBe(4);
  });

  it("excludes files and recomputes totals", () => {
    const summary = summarizeChangeSelection(FILES, new Set(["tasks.md"]));
    expect(summary.allSelected).toBe(false);
    expect(summary.selectedCount).toBe(1);
    expect(summary.insertions).toBe(218);
    expect(summary.deletions).toBe(0);
  });

  it("reports noneSelected when every file is excluded", () => {
    const summary = summarizeChangeSelection(
      FILES,
      new Set(["tasks.md", "docs/prps/PFS-1848/master-plan.md"]),
    );
    expect(summary.noneSelected).toBe(true);
  });
});

describe("resolveCommitFilePaths", () => {
  it("omits filePaths when everything is selected", () => {
    expect(resolveCommitFilePaths(summarizeChangeSelection(FILES, new Set()))).toBeUndefined();
  });

  it("returns the selected subset when partial", () => {
    expect(resolveCommitFilePaths(summarizeChangeSelection(FILES, new Set(["tasks.md"])))).toEqual([
      "docs/prps/PFS-1848/master-plan.md",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/components/SourceControlPanel.logic.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the logic module**

Create `apps/web/src/components/SourceControlPanel.logic.ts`:

```ts
import type { VcsStatusResult } from "@t4code/contracts";

export interface WorkingTreeFile {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

export interface FilePathParts {
  readonly dir: string | null;
  readonly name: string;
}

export function splitFilePath(path: string): FilePathParts {
  const index = path.lastIndexOf("/");
  if (index < 0) return { dir: null, name: path };
  return { dir: path.slice(0, index), name: path.slice(index + 1) };
}

export interface ChangeSelectionSummary {
  readonly selectedFiles: WorkingTreeFile[];
  readonly allSelected: boolean;
  readonly noneSelected: boolean;
  readonly selectedCount: number;
  readonly totalCount: number;
  readonly insertions: number;
  readonly deletions: number;
}

export function summarizeChangeSelection(
  files: readonly WorkingTreeFile[],
  excludedPaths: ReadonlySet<string>,
): ChangeSelectionSummary {
  const selectedFiles = files.filter((file) => !excludedPaths.has(file.path));
  const insertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);
  return {
    selectedFiles,
    allSelected: excludedPaths.size === 0,
    noneSelected: selectedFiles.length === 0,
    selectedCount: selectedFiles.length,
    totalCount: files.length,
    insertions,
    deletions,
  };
}

/**
 * Forward the selected subset to the git action only when it is a strict subset;
 * when everything is selected we omit `filePaths` so the backend commits the
 * whole working tree (matching `GitActionsControl`'s `runDialogAction`).
 */
export function resolveCommitFilePaths(summary: ChangeSelectionSummary): string[] | undefined {
  return summary.allSelected ? undefined : summary.selectedFiles.map((file) => file.path);
}

export function workingTreeFiles(status: VcsStatusResult | null | undefined): WorkingTreeFile[] {
  return status ? status.workingTree.files.map((file) => ({ ...file })) : [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/components/SourceControlPanel.logic.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SourceControlPanel.logic.ts apps/web/src/components/SourceControlPanel.logic.test.ts
git commit -m "feat(source-control): add source control panel selection logic"
```

---

### Task 4: Presentational changed-files list

**Files:**

- Create: `apps/web/src/components/SourceControlChangesList.tsx`
- Test: `apps/web/src/components/SourceControlChangesList.test.tsx`

**Interfaces:**

- Consumes: `WorkingTreeFile`, `splitFilePath` from `./SourceControlPanel.logic`; `Checkbox` from `~/components/ui/checkbox`.
- Produces: `SourceControlChangesList` with props `{ files: readonly WorkingTreeFile[]; excludedPaths: ReadonlySet<string>; onToggle: (path: string) => void; onOpenFile: (path: string) => void; renderBadge?: (file: WorkingTreeFile) => ReactNode }`. The `renderBadge` slot is the extension point Plan 02 uses to inject the status badge.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/SourceControlChangesList.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SourceControlChangesList } from "./SourceControlChangesList";
import type { WorkingTreeFile } from "./SourceControlPanel.logic";

const FILES: WorkingTreeFile[] = [
  { path: "docs/prps/PFS-1848/master-plan.md", insertions: 218, deletions: 0 },
  { path: "tasks.md", insertions: 139, deletions: 4 },
];

describe("SourceControlChangesList", () => {
  it("renders each file's name, directory hint and +/- counts", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={FILES}
        excludedPaths={new Set()}
        onToggle={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect(markup).toContain("master-plan.md");
    expect(markup).toContain("docs/prps/PFS-1848");
    expect(markup).toContain("+218");
    expect(markup).toContain("-4");
  });

  it("renders the injected badge slot", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={FILES}
        excludedPaths={new Set()}
        onToggle={() => {}}
        onOpenFile={() => {}}
        renderBadge={(file) => (
          <span data-testid="badge">{file.path === "tasks.md" ? "U" : "M"}</span>
        )}
      />,
    );
    expect(markup).toContain('data-testid="badge"');
  });

  it("renders an empty state when there are no files", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={[]}
        excludedPaths={new Set()}
        onToggle={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect(markup).toContain("No changes");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/components/SourceControlChangesList.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/SourceControlChangesList.tsx`:

```tsx
import type { ReactNode } from "react";

import { Checkbox } from "~/components/ui/checkbox";
import { cn } from "~/lib/utils";

import { splitFilePath, type WorkingTreeFile } from "./SourceControlPanel.logic";

interface SourceControlChangesListProps {
  files: readonly WorkingTreeFile[];
  excludedPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  renderBadge?: (file: WorkingTreeFile) => ReactNode;
}

export function SourceControlChangesList(props: SourceControlChangesListProps) {
  if (props.files.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">No changes</p>;
  }
  return (
    <div className="space-y-0.5 p-1">
      {props.files.map((file) => {
        const { dir, name } = splitFilePath(file.path);
        const excluded = props.excludedPaths.has(file.path);
        return (
          <div
            key={file.path}
            className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50"
          >
            <Checkbox
              checked={!excluded}
              onCheckedChange={() => props.onToggle(file.path)}
              aria-label={`Include ${file.path}`}
            />
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => props.onOpenFile(file.path)}
              title={file.path}
            >
              <span
                className={cn(
                  "shrink-0 truncate font-mono text-xs",
                  excluded && "text-muted-foreground line-through",
                )}
              >
                {name}
              </span>
              {dir ? (
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir}</span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-[11px]">
                <span className="text-success">+{file.insertions}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-destructive">-{file.deletions}</span>
              </span>
              {props.renderBadge?.(file)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @t4code/web exec vp test run --project unit apps/web/src/components/SourceControlChangesList.test.tsx`
Expected: PASS (3 tests).

> If `renderToStaticMarkup` throws on the base-ui `Checkbox` (missing context), that is the only expected failure mode here; the fix is to wrap the `Checkbox` usage so it renders server-side, but base-ui `Checkbox`/`Radio` are already rendered by `GitActionsControl` in this codebase, so it is expected to SSR cleanly. Do not swap to a native input unless the test proves it necessary.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SourceControlChangesList.tsx apps/web/src/components/SourceControlChangesList.test.tsx
git commit -m "feat(source-control): add presentational changes list"
```

---

### Task 5: The `SourceControlPanel` component

**Files:**

- Create: `apps/web/src/components/SourceControlPanel.tsx`

**Interfaces:**

- Consumes: `vcsEnvironment.status` (`~/state/vcs`), `useEnvironmentQuery` (`~/state/query`), `useGitStackedAction`/`useVcsPullAction`/`useSourceControlActionRunning` (`~/lib/sourceControlActions`), `getSourceControlPresentation` (`~/sourceControlPresentation`), `buildMenuItems`/`resolveQuickAction`/`requiresDefaultBranchConfirmation`/`resolveDefaultBranchActionDialogCopy` (`./GitActionsControl.logic`), `DiffPanelShell`/`DiffPanelMode` (`./DiffPanelShell`), draft store, `SourceControlPanel.logic`, `SourceControlChangesList`, `useRightPanelStore`, `useDiffPanelStore`, `toastManager`/`stackedThreadToast` (`~/components/ui/toast`), `isAtomCommandInterrupted`/`squashAtomCommandFailure` (`@t4code/client-runtime/state/runtime`), `randomUUID` (`~/lib/utils`), `openPullRequestLink` (`~/lib/openPullRequestLink`), `readLocalApi` (`~/localApi`).
- Produces: `export default function SourceControlPanel(props: { mode: DiffPanelMode; threadRef: ScopedThreadRef; gitCwd: string | null })`.

- [ ] **Step 1: Write the component**

> This task has no unit test — it is a composition of already-tested hooks and the already-tested logic/store/list units. Its verification is `typecheck` + `lint` (this task) and the manual smoke test in Task 7. This matches the codebase convention where `GitActionsControl.tsx` has no component test (only `GitActionsControl.logic.test.ts`).

Create `apps/web/src/components/SourceControlPanel.tsx`:

```tsx
import type { GitStackedAction, ScopedThreadRef, VcsStatusResult } from "@t4code/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t4code/client-runtime/state/runtime";
import { ChevronDownIcon, CloudUploadIcon, GitCommitIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useDiffPanelStore } from "~/diffPanelStore";
import { randomUUID } from "~/lib/utils";
import { openPullRequestLink } from "~/lib/openPullRequestLink";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsPullAction,
} from "~/lib/sourceControlActions";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import {
  selectThreadSourceControlDraft,
  useSourceControlPanelStore,
} from "~/sourceControlPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { cn } from "~/lib/utils";

import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import {
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  type DefaultBranchConfirmableAction,
} from "./GitActionsControl.logic";
import { SourceControlChangesList } from "./SourceControlChangesList";
import {
  resolveCommitFilePaths,
  summarizeChangeSelection,
  workingTreeFiles,
} from "./SourceControlPanel.logic";

interface SourceControlPanelProps {
  mode: DiffPanelMode;
  threadRef: ScopedThreadRef;
  gitCwd: string | null;
}

const RUNNING_ACTIONS = ["runStackedAction", "pull"] as const;

function isDefaultBranchConfirmable(
  action: GitStackedAction,
): action is DefaultBranchConfirmableAction {
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export default function SourceControlPanel({ mode, threadRef, gitCwd }: SourceControlPanelProps) {
  const environmentId = threadRef.environmentId;
  const scope = useMemo(() => ({ environmentId, cwd: gitCwd }), [environmentId, gitCwd]);

  const statusQuery = useEnvironmentQuery(
    gitCwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }),
  );
  const status: VcsStatusResult | null = statusQuery.data ?? null;

  const draft = useSourceControlPanelStore((store) =>
    selectThreadSourceControlDraft(store.byThreadKey, threadRef),
  );
  const setMessage = useSourceControlPanelStore((store) => store.setMessage);
  const toggleExcludedPath = useSourceControlPanelStore((store) => store.toggleExcludedPath);
  const setExcludedPaths = useSourceControlPanelStore((store) => store.setExcludedPaths);
  const clearDraft = useSourceControlPanelStore((store) => store.clearDraft);

  const runAction = useGitStackedAction(scope);
  const pullAction = useVcsPullAction(scope);
  const isBusy = useSourceControlActionRunning(scope, RUNNING_ACTIONS);

  const [pendingConfirm, setPendingConfirm] = useState<{
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
  } | null>(null);

  const files = useMemo(() => workingTreeFiles(status), [status]);
  const excludedPaths = useMemo(() => new Set(draft.excludedPaths), [draft.excludedPaths]);
  const summary = useMemo(
    () => summarizeChangeSelection(files, excludedPaths),
    [files, excludedPaths],
  );
  const presentation = useMemo(
    () => getSourceControlPresentation(status?.sourceControlProvider),
    [status?.sourceControlProvider],
  );
  const terminology = presentation.terminology;
  const isDefaultRef = status?.isDefaultRef ?? false;
  const hasPrimaryRemote = status?.hasPrimaryRemote ?? false;

  const quickAction = useMemo(
    () => resolveQuickAction(status, isBusy, isDefaultRef, hasPrimaryRemote),
    [status, isBusy, isDefaultRef, hasPrimaryRemote],
  );
  const menuItems = useMemo(
    () => buildMenuItems(status, isBusy, hasPrimaryRemote),
    [status, isBusy, hasPrimaryRemote],
  );

  const threadToastData = useMemo(() => ({ threadRef }), [threadRef]);

  const runGitAction = useCallback(
    async (action: GitStackedAction, options?: { skipConfirm?: boolean }) => {
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      if (
        !options?.skipConfirm &&
        isDefaultBranchConfirmable(action) &&
        requiresDefaultBranchConfirmation(action, isDefaultRef) &&
        status?.refName
      ) {
        setPendingConfirm({
          action,
          branchName: status.refName,
          includesCommit:
            actionCanCommit && (action === "commit_push" ? status.hasWorkingTreeChanges : true),
        });
        return;
      }

      const message = draft.message.trim();
      const filePaths = resolveCommitFilePaths(summary);
      const toastId = toastManager.add({
        type: "loading",
        title: "Running source control action…",
        description: "Waiting for Git…",
        timeout: 0,
        data: threadToastData,
      });
      const result = await runAction.run({
        actionId: randomUUID(),
        action,
        ...(message ? { commitMessage: message } : {}),
        ...(filePaths ? { filePaths } : {}),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(toastId);
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            data: threadToastData,
          }),
        );
        return;
      }
      // Commit succeeded: clear the message (keep excluded-file selection reset too).
      if (actionCanCommit) {
        clearDraft(threadRef);
      }
      toastManager.update(toastId, {
        type: "success",
        title: result.value.toast.title,
        description: result.value.toast.description,
        timeout: 0,
        data: { ...threadToastData, dismissAfterVisibleMs: 10_000 },
      });
    },
    [
      clearDraft,
      draft.message,
      isDefaultRef,
      runAction,
      status,
      summary,
      threadRef,
      threadToastData,
    ],
  );

  const runPull = useCallback(async () => {
    const toastId = toastManager.add({
      type: "loading",
      title: "Pulling…",
      timeout: 0,
      data: threadToastData,
    });
    const result = await pullAction.run();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "error",
          title: "Pull failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        }),
      );
      return;
    }
    toastManager.update(toastId, {
      type: "success",
      title: result.value.status === "pulled" ? "Pulled" : "Already up to date",
      timeout: 0,
      data: threadToastData,
    });
  }, [pullAction, threadToastData]);

  const openPr = useCallback(() => {
    const api = readLocalApi();
    const prUrl = status?.pr?.state === "open" ? status.pr.url : null;
    if (!api || !prUrl) return;
    void openPullRequestLink(api.shell, prUrl);
  }, [status]);

  const onPrimaryAction = useCallback(() => {
    if (quickAction.kind === "open_pr") return openPr();
    if (quickAction.kind === "run_pull") return void runPull();
    if (quickAction.kind === "run_action" && quickAction.action)
      return void runGitAction(quickAction.action);
    // open_publish / show_hint: no-op here (surfaced as disabled below).
  }, [openPr, quickAction, runGitAction, runPull]);

  const openFileInDiff = useCallback(
    (_path: string) => {
      useRightPanelStore.getState().open(threadRef, "diff");
      useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged");
    },
    [threadRef],
  );

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate text-sm font-medium">{status?.refName ?? "Source Control"}</span>
      {status?.pr?.state === "open" ? (
        <button
          type="button"
          onClick={openPr}
          className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {terminology.shortLabel} #{status.pr.number}
        </button>
      ) : null}
      {status && (status.aheadCount > 0 || status.behindCount > 0) ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {status.aheadCount > 0 ? `↑${status.aheadCount}` : ""}{" "}
          {status.behindCount > 0 ? `↓${status.behindCount}` : ""}
        </span>
      ) : null}
    </div>
  );

  const primaryDisabled =
    isBusy || quickAction.disabled || (quickAction.kind === "run_action" && summary.noneSelected);
  const pendingConfirmCopy = pendingConfirm
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingConfirm.action,
        branchName: pendingConfirm.branchName,
        includesCommit: pendingConfirm.includesCommit,
        terminology,
      })
    : null;

  return (
    <DiffPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <Textarea
          value={draft.message}
          onChange={(event) => setMessage(threadRef, event.target.value)}
          placeholder="Message (leave empty to auto-generate)"
          size="sm"
          aria-label="Commit message"
        />

        <div className="flex items-center gap-1">
          <Button className="flex-1" size="sm" disabled={primaryDisabled} onClick={onPrimaryAction}>
            {isBusy ? <Spinner className="size-3.5" aria-hidden /> : null}
            {quickAction.label}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button aria-label="Source control actions" size="icon-sm" variant="outline" />
              }
              disabled={isBusy}
            >
              <ChevronDownIcon className="size-4" aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              {menuItems.map((item) => (
                <MenuItem
                  key={item.id}
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.kind === "open_pr") return openPr();
                    if (item.dialogAction) return void runGitAction(item.dialogAction);
                  }}
                >
                  {item.icon === "commit" ? (
                    <GitCommitIcon />
                  ) : item.icon === "push" ? (
                    <CloudUploadIcon />
                  ) : (
                    <presentation.Icon />
                  )}
                  {item.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </div>

        <div className="flex items-center justify-between px-1 pt-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Changes {summary.totalCount > 0 ? summary.totalCount : ""}
          </span>
          {files.length > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                setExcludedPaths(
                  threadRef,
                  summary.allSelected ? files.map((file) => file.path) : [],
                )
              }
            >
              {summary.allSelected ? "Deselect all" : "Select all"}
            </Button>
          ) : null}
        </div>

        <ScrollArea className="min-h-0 flex-1 rounded-md border border-border/60">
          {statusQuery.isPending && !status ? (
            <p className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <RefreshCwIcon className="size-3.5 animate-spin" aria-hidden /> Loading changes…
            </p>
          ) : (
            <SourceControlChangesList
              files={files}
              excludedPaths={excludedPaths}
              onToggle={(path) => toggleExcludedPath(threadRef, path)}
              onOpenFile={openFileInDiff}
            />
          )}
        </ScrollArea>

        {summary.totalCount > 0 ? (
          <div className={cn("flex justify-end px-1 font-mono text-[11px]")}>
            <span className="text-success">+{summary.insertions}</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-destructive">-{summary.deletions}</span>
          </div>
        ) : null}
      </div>

      <Dialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => !open && setPendingConfirm(null)}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingConfirmCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingConfirmCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const action = pendingConfirm?.action;
                setPendingConfirm(null);
                if (action) void runGitAction(action, { skipConfirm: true });
              }}
            >
              {pendingConfirmCopy?.continueLabel ?? "Continue"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </DiffPanelShell>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm --filter @t4code/web exec tsgo --noEmit`
Expected: no errors in `SourceControlPanel.tsx`.
Run: `pnpm lint`
Expected: no new lint errors.

> If `tsgo` reports that `size="icon-sm"` or `size="xs"` is not a valid `Button` size, open `apps/web/src/components/ui/button.tsx` and use the nearest existing size token (e.g. `"icon-xs"` / `"sm"`); `GitActionsControl.tsx` uses `size="icon-xs"` and `size="xs"`, so those are known-valid.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/SourceControlPanel.tsx
git commit -m "feat(source-control): add SourceControlPanel composed from existing git APIs"
```

---

### Task 6: Wire the surface into `RightPanelTabs`

**Files:**

- Modify: `apps/web/src/components/RightPanelTabs.tsx` (lines 3, 28-51, 53-57, 89-131, 189-219, 237-270, 437-474, 480-494)

**Interfaces:**

- Consumes: `SourceControlPanel` is NOT imported here (only in ChatView). This task only adds the chooser/menu/tab affordances + two new props (`onAddSourceControl`, `sourceControlAvailable`).
- Produces: `RightPanelTabsProps` gains `onAddSourceControl: () => void` and `sourceControlAvailable: boolean`.

- [ ] **Step 1: Add the icon import**

`apps/web/src/components/RightPanelTabs.tsx` line 3 — add `GitPullRequestArrow` to the lucide import:

```ts
import {
  ClipboardList,
  FileDiff,
  Files,
  GitPullRequestArrow,
  Globe2,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
```

- [ ] **Step 2: Add the two props to `RightPanelTabsProps`**

In `interface RightPanelTabsProps` (after `onAddFiles: () => void;`, line 46) add:

```ts
  onAddSourceControl: () => void;
```

and after `filesAvailable: boolean;` (line 49) add:

```ts
sourceControlAvailable: boolean;
```

- [ ] **Step 3: Add the disabled reason**

In `SURFACE_DISABLED_REASONS` (lines 53-57), add a `sourceControl` entry:

```ts
const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the T4Code desktop app.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  sourceControl: "Source control is only available for server threads in Git repositories.",
} as const;
```

- [ ] **Step 4: Add the chooser card**

`RightPanelEmptyState` receives its actions inline. First extend its props (function signature at line 89):

```tsx
function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddSourceControl: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  sourceControlAvailable: boolean;
}) {
```

Then add a `Source Control` entry to the `actions` array — insert it immediately after the `Diff` entry (after line 130), so the git-related cards sit together (the 5 cards flow 2×2 + 1 in the `grid-cols-2` layout, which is intentional):

```tsx
    {
      label: "Source Control",
      description: "Stage, commit, and open changes.",
      icon: GitPullRequestArrow,
      available: props.sourceControlAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.sourceControl,
      onClick: props.onAddSourceControl,
    },
```

- [ ] **Step 5: Add the tab title + icon cases**

In `surfaceTitle` (switch at line 194) add:

```ts
    case "sourceControl":
      return "Source Control";
```

In `SurfaceIcon` (switch at line 246) add:

```tsx
    case "sourceControl":
      return <GitPullRequestArrow className="size-3.5 shrink-0" />;
```

- [ ] **Step 6: Add the `+` menu item**

In the `+` menu (`MenuPopup` at lines 444-473), after the `Diff` `SurfaceMenuItem` (line 472) add:

```tsx
<SurfaceMenuItem
  available={props.sourceControlAvailable}
  disabledReason={SURFACE_DISABLED_REASONS.sourceControl}
  onClick={props.onAddSourceControl}
>
  <GitPullRequestArrow />
  Source Control
</SurfaceMenuItem>
```

- [ ] **Step 7: Pass the new props into `RightPanelEmptyState`**

In the `RightPanelEmptyState` render (lines 482-490) add:

```tsx
<RightPanelEmptyState
  onAddBrowser={props.onAddBrowser}
  onAddTerminal={props.onAddTerminal}
  onAddDiff={props.onAddDiff}
  onAddFiles={props.onAddFiles}
  onAddSourceControl={props.onAddSourceControl}
  browserAvailable={props.browserAvailable}
  diffAvailable={props.diffAvailable}
  filesAvailable={props.filesAvailable}
  sourceControlAvailable={props.sourceControlAvailable}
/>
```

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @t4code/web exec tsgo --noEmit`
Expected: **Errors are expected and desired here** — `ChatView.tsx` now fails to compile because it renders `<RightPanelTabs>` without the two new required props. Task 7 fixes those call sites. Confirm the only errors are the two missing-prop errors in `ChatView.tsx`, and no errors inside `RightPanelTabs.tsx` itself.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/RightPanelTabs.tsx
git commit -m "feat(source-control): add Source Control chooser card, tab and menu"
```

---

### Task 7: Wire `ChatView` (make it live) + manual verification

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx` (lines ~262 import, ~2772 add-callback, ~4969 content branch, ~5315/5342 render props)

**Interfaces:**

- Consumes: `SourceControlPanel` (`./SourceControlPanel`), `addSourceControlSurface`, `isServerThread`, `isGitRepo`, `gitCwd`, `activeThreadRef`.

- [ ] **Step 1: Lazy-import the panel**

`apps/web/src/components/ChatView.tsx` near line 262 (next to `const DiffPanel = lazy(() => import("./DiffPanel"));`):

```ts
const SourceControlPanel = lazy(() => import("./SourceControlPanel"));
```

- [ ] **Step 2: Add the add-surface callback**

Immediately after `addDiffSurface` (ends line 2776), add:

```ts
const addSourceControlSurface = useCallback(() => {
  if (!activeThreadRef || !isServerThread || !isGitRepo) return;
  useRightPanelStore.getState().open(activeThreadRef, "sourceControl");
}, [activeThreadRef, isGitRepo, isServerThread]);
```

- [ ] **Step 3: Add the content branch**

In `rightPanelContent` (lines 4940-5008), add a branch after the `diff` branch (after line 4972, before the `plan` branch):

```tsx
    ) : activeRightPanelSurface?.kind === "sourceControl" ? (
      <Suspense fallback={null}>
        <SourceControlPanel mode="embedded" threadRef={activeThreadRef} gitCwd={gitCwd} />
      </Suspense>
```

- [ ] **Step 4: Pass the new props at both render sites**

In the **inline** `<RightPanelTabs>` (lines 5299-5322), after `onAddDiff={addDiffSurface}` (line 5315) add `onAddSourceControl={addSourceControlSurface}`, and after `diffAvailable={isServerThread && isGitRepo}` (line 5318) add `sourceControlAvailable={isServerThread && isGitRepo}`.

In the **sheet** `<RightPanelTabs>` (lines 5326-5350), after `onAddDiff={addDiffSurface}` (line 5342) add `onAddSourceControl={addSourceControlSurface}`, and after `diffAvailable={isServerThread && isGitRepo}` (line 5345) add `sourceControlAvailable={isServerThread && isGitRepo}`.

- [ ] **Step 5: Typecheck the whole web app**

Run: `pnpm --filter @t4code/web exec tsgo --noEmit`
Expected: PASS (no errors).

- [ ] **Step 6: Run the full web unit suite**

Run: `pnpm --filter @t4code/web exec vp test run --project unit`
Expected: PASS (existing suite + the new store/logic/list tests).

- [ ] **Step 7: Manual smoke test**

Run the app: `pnpm dev:web` (see [00-overview.md → Global Constraints](./00-overview.md#global-constraints) if the runner differs). Open a **server thread inside a Git repository**, open the right panel, and:

1. Confirm the empty-state chooser shows a **Source Control** card with the description "Stage, commit, and open changes." and a git/PR icon.
2. Click it → the panel opens with a "Source Control" tab, the branch name in the header, and the working-tree changes listed with `+/-` counts.
3. Untick a file → the bottom `+/-` totals update; the primary button label reflects the resolved action.
4. Type a commit message and run the primary action on a **non-default** branch → a loading toast resolves to success and the change list refreshes (message clears after a commit).
5. Click a file row → the **Diff** surface opens showing the working-tree diff.
6. On a non-git or client thread, confirm the card is disabled with the tooltip "Source control is only available for server threads in Git repositories."

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat(source-control): wire Source Control surface into ChatView"
```

---

## Self-Review (Plan 01)

- **Spec coverage:** chooser card + description + icon ✅ (Task 6); persistent panel with list, `+/-`, selection, message, Commit/Push/Create-PR ✅ (Tasks 4–5); `vs <base>`/PR context ✅ (panel header); file-row → Diff surface ✅ (Task 5). Status badge, sections, COMMITS, and AI are explicitly deferred to Plans 02–05.
- **Placeholder scan:** every code step contains complete code; the only conditional notes are typed fallbacks for two known-variance points (base-ui `Checkbox` SSR; `Button` size tokens), each with the concrete resolution.
- **Type consistency:** the surface kind string `"sourceControl"`, the draft type `SourceControlDraft`, the `WorkingTreeFile` shape, and the panel props all match the Shared Interfaces in [00-overview.md](./00-overview.md#shared-interfaces--naming-anti-drift--all-plans-reference-these). `SourceControlChangesList.renderBadge` is the exact slot Plan 02 consumes.
- **Intentional behavior (not a bug to "fix"):** `openFileInDiff` opens the Diff surface at the `"unstaged"` working-tree scope for **any** row clicked — it does not reveal the specific file (the diff store has no per-file reveal for the unstaged scope; `selectTurn`'s `filePath` reveal is turn-scoped only). This satisfies the chosen "open the existing Diff surface" behavior. Per-file reveal is a deferred enhancement (it would add a `revealRequestId` to the `unstaged` selection in `diffPanelStore`). The `_path` arg is intentionally unused — keep the underscore prefix so lint does not flag it.
