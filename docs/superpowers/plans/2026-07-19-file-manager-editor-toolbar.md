# File Manager Editor Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a theme-aware Save/Undo/Redo toolbar to every selected File Manager file while retaining autosave and independent native edit history for open file tabs.

**Architecture:** Extend `FileSaveCoordinator` into the authoritative observable save-state machine, wrap Pierre's persistent editor and the coordinator in one `FileEditingSession` per open file, and retain those sessions in a lightweight project-scoped registry owned above the active right-panel surface. `FilePreviewPanel` mounts only the active Pierre view, subscribes to its session, and renders a dedicated presentational toolbar below the existing breadcrumb row.

**Tech Stack:** React 19, TypeScript, Vite+, Pierre Diffs `Editor`, Lucide React, Base UI button/tooltip primitives, Effect `AtomCommandResult`, Zustand right-panel state.

## Global Constraints

- Follow red-green-refactor for every behavior change.
- Keep the existing 500 ms autosave debounce.
- Save is an immediate flush; it does not replace or disable autosave.
- Preserve the current Ctrl/Cmd+S behavior and Pierre's native undo/redo shortcuts.
- Use Pierre's native `Editor.canUndo`, `Editor.canRedo`, `Editor.undo()`, and `Editor.redo()`; do not add a second text-history stack.
- Preserve each open file's history while switching file tabs or temporarily opening another right-panel tool.
- Mount only the active file view; inactive files retain non-DOM session state.
- Show the dedicated toolbar for every selected file, including loading, error, truncated, rendered Markdown, and other read-only states.
- Do not show the toolbar when no file is selected and the full-width explorer is active.
- Use Lucide `Save`, `Undo2`, `Redo2`, and `LoaderCircle` icons with semantic theme classes and `currentColor`; do not add fixed light/dark icon colors.
- Icon-only controls require accessible names, tooltips, focus rings, and native disabled semantics.
- Rendered Markdown task changes can use Save, but Undo and Redo remain disabled until source editing is active.
- Preserve query-cache confirmation, pending tab markers, rename/delete ordering, and protection against writes resurrecting old paths.
- Do not add production dependencies or a Node runtime.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Structure

### Create

- `apps/web/src/components/files/fileEditingSession.ts` — one file's Pierre editor, save coordinator, stable cache key, toolbar snapshot, and mutable rename-safe path.
- `apps/web/src/components/files/fileEditingSession.test.ts` — native history delegation, snapshot publication, path remapping, and rendered-Markdown history reset tests.
- `apps/web/src/components/files/fileEditingSessionRegistry.ts` — project-scoped session retention, path matching, mutation preparation, rename/delete reconciliation, and disposal.
- `apps/web/src/components/files/fileEditingSessionRegistry.test.ts` — independent-session, directory-boundary, failed-settle, remap, removal, and reconciliation tests.
- `apps/web/src/components/files/FileEditorToolbar.tsx` — dedicated theme-aware icon toolbar and transient Saved indicator.
- `apps/web/src/components/files/FileEditorToolbar.test.tsx` — button ordering, enabled states, callbacks, statuses, accessibility, and Saved timeout tests.

### Modify

- `apps/web/src/components/files/fileSaveCoordinator.ts` — add observable save snapshots and a mutation-safe `settle()` operation.
- `apps/web/src/components/files/fileSaveCoordinator.test.ts` — cover every phase, subscriptions, confirmation revisions, retry, and in-flight settlement.
- `apps/web/src/components/files/FilePreviewPanel.tsx` — obtain/reuse the active session, render the toolbar, bind source/Markdown surfaces, and remove local coordinator registration.
- `apps/web/src/components/files/FilePreviewPanel.test.tsx` — cover toolbar placement, state mapping, source actions, Markdown Save, read-only states, and shortcut parity.
- `apps/web/src/components/files/FileBrowserPanel.tsx` — abort mutations after failed session settlement and notify the registry after rename/delete.
- `apps/web/src/components/files/FileBrowserPanel.test.tsx` — cover failed preparation, registry remap/removal callbacks, and duplicate abort.
- `apps/web/src/components/ChatView.tsx` — own the project-scoped registry, reconcile it with open file surfaces, and pass it into `FilePreviewPanel`.
- `apps/web/src/components/ChatView.hooks.test.tsx` — capture and assert registry wiring for file surfaces.
- `docs/user/workspace-ui.md` — document the toolbar, autosave flush, native history, and read-only behavior.

---

### Task 1: Observable and settleable save coordinator

**Files:**

- Modify: `apps/web/src/components/files/fileSaveCoordinator.ts:3-100`
- Test: `apps/web/src/components/files/fileSaveCoordinator.test.ts`

**Interfaces:**

- Produces: `FileSavePhase`, `FileSaveSnapshot`, `FileSaveSettleResult`, `FileSaveCoordinator.getSnapshot()`, `FileSaveCoordinator.subscribe()`, and `FileSaveCoordinator.settle()`.
- Preserves: `FileSaveCoordinator.change()`, `flush()`, `hasPendingWork()`, `dispose()`, and `FileSaveFlushResult`.
- Consumes: `AtomCommandResult`, the existing revision counters, and the existing `onPendingChange`/`onConfirmed` callbacks.

- [ ] **Step 1: Write failing phase and subscription tests**

Add these imports and tests to `fileSaveCoordinator.test.ts`:

```ts
import {
  FileSaveCoordinator,
  type FileSaveSnapshot,
} from "./fileSaveCoordinator";

it("publishes stable clean, pending, saving, and clean snapshots", async () => {
  vi.useFakeTimers();
  const write = deferred();
  const coordinator = new FileSaveCoordinator({
    debounceMs: 500,
    persist: vi.fn(() => write.promise),
    onPendingChange: vi.fn(),
    onConfirmed: vi.fn(),
  });
  const snapshots: FileSaveSnapshot[] = [];
  const unsubscribe = coordinator.subscribe(() => {
    snapshots.push(coordinator.getSnapshot());
  });

  expect(coordinator.getSnapshot()).toEqual({
    phase: "clean",
    canSave: false,
    confirmedRevision: 0,
  });

  coordinator.change("draft");
  expect(coordinator.getSnapshot()).toEqual({
    phase: "pending",
    canSave: true,
    confirmedRevision: 0,
  });

  await vi.advanceTimersByTimeAsync(500);
  expect(coordinator.getSnapshot()).toEqual({
    phase: "saving",
    canSave: false,
    confirmedRevision: 0,
  });

  write.resolve(AsyncResult.success(undefined));
  await Promise.resolve();
  expect(coordinator.getSnapshot()).toEqual({
    phase: "clean",
    canSave: false,
    confirmedRevision: 1,
  });
  expect(snapshots.map(({ phase }) => phase)).toEqual(["pending", "saving", "clean"]);

  unsubscribe();
  coordinator.change("after unsubscribe");
  expect(snapshots.map(({ phase }) => phase)).toEqual(["pending", "saving", "clean"]);
});

it("publishes a retryable failed snapshot without confirming the revision", async () => {
  vi.useFakeTimers();
  const coordinator = new FileSaveCoordinator({
    debounceMs: 500,
    persist: vi
      .fn()
      .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disk full")))),
    onPendingChange: vi.fn(),
    onConfirmed: vi.fn(),
  });

  coordinator.change("draft");
  await vi.advanceTimersByTimeAsync(500);
  await Promise.resolve();

  expect(coordinator.getSnapshot()).toEqual({
    phase: "failed",
    canSave: true,
    confirmedRevision: 0,
  });
});
```

- [ ] **Step 2: Run the coordinator test and verify the new cases fail**

Run:

```bash
vp test run apps/web/src/components/files/fileSaveCoordinator.test.ts
```

Expected: FAIL because `FileSaveSnapshot`, `getSnapshot()`, and `subscribe()` do not exist.

- [ ] **Step 3: Add the save snapshot API**

Add these exports and fields to `fileSaveCoordinator.ts`:

```ts
export type FileSavePhase = "clean" | "pending" | "saving" | "failed";

export interface FileSaveSnapshot {
  readonly phase: FileSavePhase;
  readonly canSave: boolean;
  readonly confirmedRevision: number;
}

const CLEAN_FILE_SAVE_SNAPSHOT: FileSaveSnapshot = {
  phase: "clean",
  canSave: false,
  confirmedRevision: 0,
};
```

Add these members to `FileSaveCoordinator`:

```ts
private snapshot: FileSaveSnapshot = CLEAN_FILE_SAVE_SNAPSHOT;
private readonly listeners = new Set<() => void>();

readonly getSnapshot = (): FileSaveSnapshot => this.snapshot;

readonly subscribe = (listener: () => void): (() => void) => {
  this.listeners.add(listener);
  return () => {
    this.listeners.delete(listener);
  };
};

private publish(phase: FileSavePhase): void {
  const next: FileSaveSnapshot = {
    phase,
    canSave: phase === "pending" || phase === "failed",
    confirmedRevision: this.persistedRevision,
  };
  if (
    next.phase === this.snapshot.phase &&
    next.canSave === this.snapshot.canSave &&
    next.confirmedRevision === this.snapshot.confirmedRevision
  ) {
    return;
  }
  this.snapshot = next;
  for (const listener of this.listeners) listener();
}
```

Update `change()` to call `publish("pending")` before scheduling. Update
`persistLatest()` to publish `saving` before the write, `clean` only when the
confirmed revision remains latest, `pending` when a newer revision exists, and
`failed` when the latest write fails. Keep `onPendingChange(false)` restricted
to a successful write of the latest revision.

- [ ] **Step 4: Run the coordinator tests and verify the phase cases pass**

Run:

```bash
vp test run apps/web/src/components/files/fileSaveCoordinator.test.ts
```

Expected: PASS for the original debounce/revision cases and the new snapshot cases.

- [ ] **Step 5: Write failing settlement tests**

Add:

```ts
it("settle waits for an in-flight write and then persists a newer revision", async () => {
  vi.useFakeTimers();
  const firstWrite = deferred();
  const persist = vi
    .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
    .mockReturnValueOnce(firstWrite.promise)
    .mockResolvedValueOnce(AsyncResult.success(undefined));
  const coordinator = new FileSaveCoordinator({
    debounceMs: 500,
    persist,
    onPendingChange: vi.fn(),
    onConfirmed: vi.fn(),
  });

  coordinator.change("first");
  await vi.advanceTimersByTimeAsync(500);
  coordinator.change("latest");
  const settled = coordinator.settle();
  expect(persist).toHaveBeenCalledTimes(1);

  firstWrite.resolve(AsyncResult.success(undefined));
  await expect(settled).resolves.toBe("saved");
  expect(persist).toHaveBeenCalledTimes(2);
  expect(persist).toHaveBeenLastCalledWith("latest");
  expect(coordinator.getSnapshot().phase).toBe("clean");
});

it("settle reports failure and leaves the latest revision retryable", async () => {
  const coordinator = new FileSaveCoordinator({
    debounceMs: 500,
    persist: vi
      .fn()
      .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("read only")))),
    onPendingChange: vi.fn(),
    onConfirmed: vi.fn(),
  });
  coordinator.change("draft");

  await expect(coordinator.settle()).resolves.toBe("failed");
  expect(coordinator.getSnapshot()).toMatchObject({ phase: "failed", canSave: true });
});
```

- [ ] **Step 6: Run the settlement cases and verify they fail**

Run:

```bash
vp test run apps/web/src/components/files/fileSaveCoordinator.test.ts
```

Expected: FAIL because `settle()` is not defined.

- [ ] **Step 7: Implement mutation-safe settlement**

Add:

```ts
export type FileSaveSettleResult = "saved" | "unchanged" | "failed";
```

Track the current persistence promise:

```ts
private inFlight: Promise<boolean> | null = null;
```

Refactor the body that performs one write into a promise assigned to
`inFlight`, and clear that field in `finally`. Then add:

```ts
async settle(): Promise<FileSaveSettleResult> {
  const hadUnsavedChanges = this.latestRevision !== this.persistedRevision;
  this.clearTimer();

  while (this.inFlight !== null) {
    await this.inFlight;
    this.clearTimer();
  }

  while (this.latestRevision !== this.persistedRevision) {
    const succeeded = await this.persistLatest();
    this.clearTimer();
    if (!succeeded && this.latestRevision !== this.persistedRevision) return "failed";
    while (this.inFlight !== null) await this.inFlight;
  }

  return hadUnsavedChanges ? "saved" : "unchanged";
}
```

`flush()` must retain its existing non-blocking `"saving"` return while a write
is in flight; only filesystem lifecycle code will use `settle()`.

- [ ] **Step 8: Run the coordinator suite**

Run:

```bash
vp test run apps/web/src/components/files/fileSaveCoordinator.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the coordinator state machine**

```bash
git add apps/web/src/components/files/fileSaveCoordinator.ts apps/web/src/components/files/fileSaveCoordinator.test.ts
git commit -m "feat(files): expose observable save state"
```

---

### Task 2: Persistent per-file editing session

**Files:**

- Create: `apps/web/src/components/files/fileEditingSession.ts`
- Create: `apps/web/src/components/files/fileEditingSession.test.ts`

**Interfaces:**

- Consumes: `Editor`, `EditorOptions`, `FileContents`, `DiffLineAnnotation`, `FileSaveCoordinator`, `FileSaveSnapshot`, `FileSaveFlushResult`, `FileSaveSettleResult`, and `AtomCommandResult`.
- Produces: `FileEditingSession`, `FileEditingSessionSnapshot`, `FileEditorChangeHandler`, `editor`, `cacheKey`, `relativePath`, `setEditorChangeHandler()`, `changeOutsideEditor()`, `flush()`, `settle()`, `undo()`, `redo()`, `rename()`, `subscribe()`, `getSnapshot()`, and `dispose()`.

- [ ] **Step 1: Write failing session tests**

Create `fileEditingSession.test.ts` with a hoisted Pierre editor double and these
core cases:

```ts
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";

const pierre = vi.hoisted(() => {
  class Editor {
    readonly options: Record<string, unknown>;
    canUndo = false;
    canRedo = false;
    readonly undo = vi.fn();
    readonly redo = vi.fn();
    readonly cleanUp = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  }
  return { Editor };
});

vi.mock("@pierre/diffs/editor", () => ({ Editor: pierre.Editor }));

import { FileEditingSession } from "./fileEditingSession";

describe("FileEditingSession", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("creates a persistent Pierre editor and publishes native history capabilities", () => {
    const session = new FileEditingSession({
      cwd: "/repo",
      relativePath: "src/app.ts",
      debounceMs: 500,
      persist: vi.fn(async () => AsyncResult.success(undefined)),
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    const editor = session.editor as unknown as InstanceType<typeof pierre.Editor>;
    expect(editor.options["persistState"]).toBe(true);
    expect(session.cacheKey).toMatch(/^\/repo:file-editing-session:/);

    editor.canUndo = true;
    (editor.options["onAttach"] as () => void)();
    expect(session.getSnapshot().canUndo).toBe(true);

    session.undo();
    expect(editor.undo).toHaveBeenCalledOnce();
  });

  it("uses the current renamed path for later persistence", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => AsyncResult.success(undefined));
    const session = new FileEditingSession({
      cwd: "/repo",
      relativePath: "src/old.ts",
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    session.rename("src/new.ts");
    const editor = session.editor as unknown as InstanceType<typeof pierre.Editor>;

    (editor.options["onChange"] as (file: { contents: string }) => void)({
      contents: "renamed contents",
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledWith("src/new.ts", "renamed contents");
  });

  it("resets source history for an out-of-editor Markdown change", () => {
    const session = new FileEditingSession({
      cwd: "/repo",
      relativePath: "README.md",
      debounceMs: 500,
      persist: vi.fn(async () => AsyncResult.success(undefined)),
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    const firstEditor = session.editor;
    const firstCacheKey = session.cacheKey;

    session.changeOutsideEditor("- [x] done\n");

    expect(firstEditor.cleanUp).toHaveBeenCalledOnce();
    expect(session.editor).not.toBe(firstEditor);
    expect(session.cacheKey).not.toBe(firstCacheKey);
    expect(session.getSnapshot().save.phase).toBe("pending");
    expect(session.getSnapshot().canUndo).toBe(false);
  });
});
```

- [ ] **Step 2: Run the session test and verify it fails**

Run:

```bash
vp test run apps/web/src/components/files/fileEditingSession.test.ts
```

Expected: FAIL because `fileEditingSession.ts` does not exist.

- [ ] **Step 3: Implement the session types and constructor**

Create `fileEditingSession.ts` with these public types:

```ts
import type { AtomCommandResult } from "@t4code/client-runtime/state/runtime";
import type { DiffLineAnnotation, FileContents } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/editor";

import {
  FileSaveCoordinator,
  type FileSaveFlushResult,
  type FileSaveSettleResult,
  type FileSaveSnapshot,
} from "./fileSaveCoordinator";

export type FileEditorChangeHandler<LAnnotation> = (
  file: FileContents,
  lineAnnotations?: DiffLineAnnotation<LAnnotation>[],
) => void;

export interface FileEditingSessionSnapshot {
  readonly save: FileSaveSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface FileEditingSessionOptions<A, E> {
  readonly cwd: string;
  readonly relativePath: string;
  readonly debounceMs: number;
  readonly persist: (
    relativePath: string,
    contents: string,
  ) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly onConfirmed: (relativePath: string, contents: string) => void;
}
```

Use a module counter for a stable, session-lifetime cache key:

```ts
let nextSessionCacheKey = 0;

function createSessionCacheKey(cwd: string): string {
  nextSessionCacheKey += 1;
  return `${cwd}:file-editing-session:${nextSessionCacheKey}`;
}
```

The constructor creates `FileSaveCoordinator`, subscribes to it, and creates an
editor with `persistState: true`. The editor callbacks must call the coordinator,
the current dynamic annotation handler, and `publish()`:

```ts
export class FileEditingSession<LAnnotation, A = unknown, E = unknown> {
  private readonly cwd: string;
  private currentRelativePath: string;
  private currentCacheKey: string;
  private readonly coordinator: FileSaveCoordinator<A, E>;
  private readonly unsubscribeCoordinator: () => void;
  private readonly listeners = new Set<() => void>();
  private editorChangeHandler: FileEditorChangeHandler<LAnnotation> | null = null;
  private snapshot!: FileEditingSessionSnapshot;
  editor: Editor<LAnnotation>;

  constructor(private readonly options: FileEditingSessionOptions<A, E>) {
    this.cwd = options.cwd;
    this.currentRelativePath = options.relativePath;
    this.currentCacheKey = createSessionCacheKey(options.cwd);
    this.coordinator = new FileSaveCoordinator({
      debounceMs: options.debounceMs,
      persist: (contents) => options.persist(this.currentRelativePath, contents),
      onPendingChange: (pending) =>
        options.onPendingChange(this.currentRelativePath, pending),
      onConfirmed: (contents) =>
        options.onConfirmed(this.currentRelativePath, contents),
    });
    this.editor = this.createEditor();
    this.snapshot = this.readSnapshot();
    this.unsubscribeCoordinator = this.coordinator.subscribe(() => this.publish());
  }

  get relativePath(): string {
    return this.currentRelativePath;
  }

  get cacheKey(): string {
    return this.currentCacheKey;
  }

  private createEditor(): Editor<LAnnotation> {
    const editorOptions: EditorOptions<LAnnotation> = {
      persistState: true,
      onAttach: () => this.publish(),
      onChange: (file, lineAnnotations) => {
        this.coordinator.change(file.contents);
        this.editorChangeHandler?.(file, lineAnnotations);
        this.publish();
      },
    };
    return new Editor<LAnnotation>(editorOptions);
  }

  private readSnapshot(): FileEditingSessionSnapshot {
    return {
      save: this.coordinator.getSnapshot(),
      canUndo: this.editor.canUndo,
      canRedo: this.editor.canRedo,
    };
  }

  private publish(): void {
    const next = this.readSnapshot();
    if (
      next.save === this.snapshot.save &&
      next.canUndo === this.snapshot.canUndo &&
      next.canRedo === this.snapshot.canRedo
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
```

- [ ] **Step 4: Implement stable snapshots and commands**

Implement:

```ts
readonly subscribe = (listener: () => void): (() => void) => {
  this.listeners.add(listener);
  return () => {
    this.listeners.delete(listener);
  };
};

readonly getSnapshot = (): FileEditingSessionSnapshot => this.snapshot;

setEditorChangeHandler(handler: FileEditorChangeHandler<LAnnotation> | null): void {
  this.editorChangeHandler = handler;
}

async flush(): Promise<FileSaveFlushResult> {
  return this.coordinator.flush();
}

async settle(): Promise<FileSaveSettleResult> {
  return this.coordinator.settle();
}

undo(): void {
  if (!this.editor.canUndo) return;
  this.editor.undo();
  this.publish();
}

redo(): void {
  if (!this.editor.canRedo) return;
  this.editor.redo();
  this.publish();
}

rename(relativePath: string): void {
  this.currentRelativePath = relativePath;
}

changeOutsideEditor(contents: string): void {
  this.editor.cleanUp();
  this.currentCacheKey = createSessionCacheKey(this.cwd);
  this.editor = this.createEditor();
  this.coordinator.change(contents);
  this.publish();
}

dispose(): void {
  this.unsubscribeCoordinator();
  this.coordinator.dispose();
  this.editor.cleanUp();
  this.editorChangeHandler = null;
  this.listeners.clear();
}
```

`publish()` builds a stable cached snapshot from
`coordinator.getSnapshot()`, `editor.canUndo`, and `editor.canRedo`, then
notifies only when one of those values changes.

- [ ] **Step 5: Run the session tests**

Run:

```bash
vp test run apps/web/src/components/files/fileEditingSession.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add and pass a callback-equivalence test**

Add a test that registers `setEditorChangeHandler()`, invokes the captured Pierre
`onChange`, and asserts both the handler and coordinator snapshot update. Then
clear the handler and prove later changes still autosave without calling the
detached React callback.

Run:

```bash
vp test run apps/web/src/components/files/fileEditingSession.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the session primitive**

```bash
git add apps/web/src/components/files/fileEditingSession.ts apps/web/src/components/files/fileEditingSession.test.ts
git commit -m "feat(files): retain per-file editing sessions"
```

---

### Task 3: Project-scoped editing-session registry

**Files:**

- Create: `apps/web/src/components/files/fileEditingSessionRegistry.ts`
- Create: `apps/web/src/components/files/fileEditingSessionRegistry.test.ts`

**Interfaces:**

- Consumes: `FileSaveFlushResult`, `FileSaveSettleResult`, and the
  `FileEditingSession` methods produced by Task 2.
- Produces: `ManagedFileEditingSession`,
  `FileEditingSessionRegistry.getOrCreate()`, `get()`,
  `preparePathMutation()`, `remapUnder()`, `removeUnder()`, `reconcile()`, and
  `dispose()`.

- [ ] **Step 1: Write failing registry tests**

Create `fileEditingSessionRegistry.test.ts`:

```ts
import { describe, expect, it, vi } from "vite-plus/test";

import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";

function fakeSession(relativePath: string) {
  return {
    relativePath,
    flush: vi.fn(async () => "saved" as const),
    settle: vi.fn(async () => "saved" as const),
    rename: vi.fn(function rename(this: { relativePath: string }, next: string) {
      this.relativePath = next;
    }),
    dispose: vi.fn(),
  };
}

describe("FileEditingSessionRegistry", () => {
  it("reuses one session per exact open file", () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const create = vi.fn(() => fakeSession("src/app.ts"));

    expect(registry.getOrCreate("src/app.ts", create)).toBe(
      registry.getOrCreate("src/app.ts", create),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("settles exact and descendant paths but not prefix lookalikes", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const child = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    const lookalike = registry.getOrCreate("srcfoo/b.ts", () => fakeSession("srcfoo/b.ts"));

    await expect(registry.preparePathMutation("src")).resolves.toBe(true);
    expect(child.settle).toHaveBeenCalledOnce();
    expect(lookalike.settle).not.toHaveBeenCalled();
  });

  it("aborts path preparation when any session fails to settle", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    session.settle.mockResolvedValue("failed");

    await expect(registry.preparePathMutation("src")).resolves.toBe(false);
  });

  it("remaps descendants and disposes removed sessions", () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/nested/a.ts", () =>
      fakeSession("src/nested/a.ts"),
    );

    registry.remapUnder("src", "lib");
    expect(session.rename).toHaveBeenCalledWith("lib/nested/a.ts");
    expect(registry.get("lib/nested/a.ts")).toBe(session);

    registry.removeUnder("lib");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(registry.get("lib/nested/a.ts")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the registry test and verify it fails**

Run:

```bash
vp test run apps/web/src/components/files/fileEditingSessionRegistry.test.ts
```

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Implement path-safe registry operations**

Create `fileEditingSessionRegistry.ts`:

```ts
import type {
  FileSaveFlushResult,
  FileSaveSettleResult,
} from "./fileSaveCoordinator";

export interface ManagedFileEditingSession {
  relativePath: string;
  flush(): Promise<FileSaveFlushResult>;
  settle(): Promise<FileSaveSettleResult>;
  rename(relativePath: string): void;
  dispose(): void;
}

function isPathAtOrUnder(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function remapPath(candidate: string, from: string, to: string): string {
  return candidate === from ? to : `${to}/${candidate.slice(`${from}/`.length)}`;
}

export class FileEditingSessionRegistry<
  Session extends ManagedFileEditingSession = ManagedFileEditingSession,
> {
  private readonly sessions = new Map<string, Session>();

  get(relativePath: string): Session | undefined {
    return this.sessions.get(relativePath);
  }

  getOrCreate(relativePath: string, create: () => Session): Session {
    const existing = this.sessions.get(relativePath);
    if (existing) return existing;
    const session = create();
    this.sessions.set(relativePath, session);
    return session;
  }

  async preparePathMutation(relativePath: string): Promise<boolean> {
    const matches = [...this.sessions.entries()]
      .filter(([candidate]) => isPathAtOrUnder(candidate, relativePath))
      .map(([, session]) => session);
    const results = await Promise.all(matches.map((session) => session.settle()));
    return results.every((result) => result !== "failed");
  }

  remapUnder(from: string, to: string): void {
    const matches = [...this.sessions.entries()].filter(([candidate]) =>
      isPathAtOrUnder(candidate, from),
    );
    for (const [candidate] of matches) this.sessions.delete(candidate);
    for (const [candidate, session] of matches) {
      const nextPath = remapPath(candidate, from, to);
      const collision = this.sessions.get(nextPath);
      if (collision && collision !== session) collision.dispose();
      session.rename(nextPath);
      this.sessions.set(nextPath, session);
    }
  }

  removeUnder(relativePath: string): void {
    for (const [candidate, session] of [...this.sessions.entries()]) {
      if (!isPathAtOrUnder(candidate, relativePath)) continue;
      this.sessions.delete(candidate);
      session.dispose();
    }
  }

  async reconcile(openRelativePaths: readonly string[]): Promise<void> {
    const open = new Set(openRelativePaths);
    const removed = [...this.sessions.entries()].filter(([path]) => !open.has(path));
    for (const [path] of removed) this.sessions.delete(path);
    await Promise.all(
      removed.map(async ([, session]) => {
        await session.settle();
        session.dispose();
      }),
    );
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        await session.settle();
        session.dispose();
      }),
    );
  }
}
```

- [ ] **Step 4: Run the registry tests**

Run:

```bash
vp test run apps/web/src/components/files/fileEditingSessionRegistry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add reconciliation and collision coverage**

Add tests proving:

- `reconcile(["a.ts"])` settles and disposes `b.ts` but retains `a.ts`;
- `dispose()` settles every session before disposal;
- remapping onto an existing destination disposes the displaced session exactly
  once and retains the renamed session.

Run:

```bash
vp test run apps/web/src/components/files/fileEditingSessionRegistry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the registry**

```bash
git add apps/web/src/components/files/fileEditingSessionRegistry.ts apps/web/src/components/files/fileEditingSessionRegistry.test.ts
git commit -m "feat(files): manage open editing sessions"
```

---

### Task 4: Dedicated toolbar component

**Files:**

- Create: `apps/web/src/components/files/FileEditorToolbar.tsx`
- Create: `apps/web/src/components/files/FileEditorToolbar.test.tsx`

**Interfaces:**

- Consumes: `FileSavePhase`, Lucide icons, `Button`, and tooltip primitives.
- Produces: `FileEditorToolbarProps` and `FileEditorToolbar`.
- Prop contract:
  `savePhase`, `confirmedRevision`, `canSave`, `canUndo`, `canRedo`,
  `cleanStatus`, `onSave`, `onUndo`, and `onRedo`.

- [ ] **Step 1: Write failing toolbar rendering and action tests**

Create `FileEditorToolbar.test.tsx` with real DOM rendering:

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileEditorToolbar } from "./FileEditorToolbar";

describe("FileEditorToolbar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("renders Save, Undo, Redo in order and invokes enabled actions", () => {
    const onSave = vi.fn();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    act(() => {
      root.render(
        <FileEditorToolbar
          savePhase="pending"
          confirmedRevision={0}
          canSave
          canUndo
          canRedo={false}
          cleanStatus={null}
          onSave={onSave}
          onUndo={onUndo}
          onRedo={onRedo}
        />,
      );
    });

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Save file",
      "Undo",
      "Redo",
    ]);
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[1]!.disabled).toBe(false);
    expect(buttons[2]!.disabled).toBe(true);
    buttons[0]!.click();
    buttons[1]!.click();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unsaved changes");
  });

  it("shows saving, retry, read-only, and transient saved statuses", () => {
    vi.useFakeTimers();
    const render = (
      savePhase: "clean" | "pending" | "saving" | "failed",
      confirmedRevision: number,
      cleanStatus: string | null,
    ) => {
      act(() => {
        root.render(
          <FileEditorToolbar
            savePhase={savePhase}
            confirmedRevision={confirmedRevision}
            canSave={savePhase === "pending" || savePhase === "failed"}
            canUndo={false}
            canRedo={false}
            cleanStatus={cleanStatus}
            onSave={vi.fn()}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });
    };

    render("saving", 0, null);
    expect(container.textContent).toContain("Saving…");
    render("failed", 0, null);
    expect(container.textContent).toContain("Save failed — retry");
    render("clean", 0, "Editing unavailable");
    expect(container.textContent).toContain("Editing unavailable");
    render("clean", 1, null);
    expect(container.textContent).toContain("Saved");
    act(() => vi.advanceTimersByTime(1_500));
    expect(container.textContent).not.toContain("Saved");
  });
});
```

- [ ] **Step 2: Run the toolbar test and verify it fails**

Run:

```bash
vp test run apps/web/src/components/files/FileEditorToolbar.test.tsx
```

Expected: FAIL because `FileEditorToolbar.tsx` does not exist.

- [ ] **Step 3: Implement the icon buttons and status mapping**

Create `FileEditorToolbar.tsx`. Use a small local `ToolbarAction` component:

```tsx
function ToolbarAction({
  label,
  tooltip,
  disabled,
  className,
  onClick,
  children,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly disabled: boolean;
  readonly className?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={className}
            disabled={disabled}
            size="icon-xs"
            variant="ghost"
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
```

Render a row with this stable layout:

```tsx
<div
  className="flex h-9 min-h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-3"
  data-file-editor-toolbar
>
  <ToolbarAction label="Save file" tooltip="Save file (Ctrl/Cmd+S)" />
  <ToolbarAction label="Undo" tooltip="Undo (Ctrl/Cmd+Z)" />
  <ToolbarAction label="Redo" tooltip="Redo (Shift+Ctrl/Cmd+Z)" />
  <span className={statusClassName} aria-live="polite">
    {status}
  </span>
</div>
```

Use `Save`, `Undo2`, and `Redo2` in normal states. Use
`LoaderCircle className="animate-spin"` while saving. Apply
`text-destructive` to the failed Save action/status and normal semantic muted
classes otherwise.

- [ ] **Step 4: Implement the 1.5-second Saved indicator**

Initialize a ref to the first rendered `confirmedRevision` so remounting an
already-saved tab does not replay the indicator. When that revision later
increases while `savePhase === "clean"`, show `Saved`, schedule a 1,500 ms
timeout, and cancel the prior timeout on phase change or unmount. Phase-specific
copy has priority:

```ts
const status =
  savePhase === "pending"
    ? "Unsaved changes"
    : savePhase === "saving"
      ? "Saving…"
      : savePhase === "failed"
        ? "Save failed — retry"
        : showSaved
          ? "Saved"
          : cleanStatus;
```

- [ ] **Step 5: Run the toolbar tests**

Run:

```bash
vp test run apps/web/src/components/files/FileEditorToolbar.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the toolbar**

```bash
git add apps/web/src/components/files/FileEditorToolbar.tsx apps/web/src/components/files/FileEditorToolbar.test.tsx
git commit -m "feat(files): add editor action toolbar"
```

---

### Task 5: Bind FilePreviewPanel to retained sessions

**Files:**

- Modify: `apps/web/src/components/files/FilePreviewPanel.tsx:1-1018`
- Modify: `apps/web/src/components/files/FilePreviewPanel.test.tsx`

**Interfaces:**

- Consumes: `FileEditingSession`, `FileEditingSessionRegistry`,
  `FileEditorToolbar`, `FileEditingSessionSnapshot`, and
  `useSyncExternalStore`.
- Adds prop: `editingSessions:
  FileEditingSessionRegistry<FileEditingSession<FileCommentAnnotationGroup>>`.
- Removes: surface-owned `useFileSaveCoordinator`, `useExplicitFileSave`,
  `onRegisterFileSave`, `activeFileSaveRef`, and `saveIndicator`.
- Preserves: 500 ms debounce, project-file query confirmation, pending tab
  callbacks, scoped Ctrl/Cmd+S, comments, line reveal, Markdown task editing,
  truncation, and existing header actions.

- [ ] **Step 1: Update the FilePreviewPanel harness and write failing toolbar-state tests**

In `FilePreviewPanel.test.tsx`, add a test registry/session double to
`testState`, pass it from `baseProps()`, record `FileEditorToolbar` props through
a module mock, and add:

```ts
it("renders the dedicated toolbar below breadcrumbs for a selected file", () => {
  setFileData("const value = 1;\n");
  const markup = renderPanel(baseProps());
  expect(markup.indexOf("data-file-breadcrumbs")).toBeLessThan(
    markup.indexOf("data-file-editor-toolbar"),
  );
  expect(markup.indexOf("data-file-editor-toolbar")).toBeLessThan(
    markup.indexOf('data-file="src/app.ts"'),
  );
});

it("maps the active editing session snapshot into toolbar actions", () => {
  setFileData("const value = 1;\n");
  testState.sessionSnapshot = {
    save: { phase: "pending", canSave: true, confirmedRevision: 0 },
    canUndo: true,
    canRedo: false,
  };
  renderPanel(baseProps());

  const toolbar = ui.find("FileEditorToolbar");
  expect(toolbar).toMatchObject({
    savePhase: "pending",
    canSave: true,
    canUndo: true,
    canRedo: false,
  });
  (toolbar.onSave as () => void)();
  (toolbar.onUndo as () => void)();
  expect(testState.session.flush).toHaveBeenCalledOnce();
  expect(testState.session.undo).toHaveBeenCalledOnce();
});

it.each(["loading", "error", "truncated"] as const)(
  "keeps unavailable controls visible for the %s state",
  (state) => {
    if (state === "error") {
      testState.fileQuery = {
        data: null,
        error: "unavailable",
        isPending: false,
        refresh: vi.fn(),
      };
    } else if (state === "truncated") {
      setFileData("partial", { truncated: true, byteLength: 2_000_000 });
    }
    renderPanel(baseProps());
    expect(ui.find("FileEditorToolbar")).toMatchObject({
      canSave: false,
      canUndo: false,
      canRedo: false,
    });
  },
);
```

- [ ] **Step 2: Run the panel test and verify the new cases fail**

Run:

```bash
vp test run apps/web/src/components/files/FilePreviewPanel.test.tsx
```

Expected: FAIL because the panel has no registry prop or toolbar.

- [ ] **Step 3: Create and subscribe to the active session**

Import `useSyncExternalStore` and add an immutable unavailable snapshot:

```ts
const UNAVAILABLE_SESSION_SNAPSHOT: FileEditingSessionSnapshot = {
  save: { phase: "clean", canSave: false, confirmedRevision: 0 },
  canUndo: false,
  canRedo: false,
};

const subscribeUnavailable = (): (() => void) => () => {};
const readUnavailable = (): FileEditingSessionSnapshot => UNAVAILABLE_SESSION_SNAPSHOT;
```

Add a `useFileEditingSession()` hook that:

1. calls `useAtomCommand(projectEnvironment.writeFile)`;
2. returns `null` unless `relativePath` and non-truncated `file.data` exist;
3. calls `editingSessions.getOrCreate(relativePath, factory)`;
4. constructs `FileEditingSession` with the current `cwd`, path, 500 ms delay,
   write command, pending callback, and query-cache confirmation callbacks.

The persistence callbacks must accept the session's mutable path:

```ts
persist: (savePath, contents) =>
  writeFile({
    environmentId,
    input: { cwd, relativePath: savePath, contents },
  }),
onPendingChange: (savePath, pending) => onPendingChange(savePath, pending),
onConfirmed: (savePath, contents) => {
  setProjectFileQueryData(environmentId, cwd, savePath, contents);
  confirmProjectFileQueryData(environmentId, cwd, savePath, contents);
},
```

Subscribe unconditionally:

```ts
const sessionSnapshot = useSyncExternalStore(
  session?.subscribe ?? subscribeUnavailable,
  session?.getSnapshot ?? readUnavailable,
  session?.getSnapshot ?? readUnavailable,
);
```

- [ ] **Step 4: Render the toolbar in the approved location**

Immediately after the existing breadcrumb/action `surface-subheader`, render
`FileEditorToolbar` whenever `relativePath !== null`:

```tsx
<FileEditorToolbar
  savePhase={sessionSnapshot.save.phase}
  confirmedRevision={sessionSnapshot.save.confirmedRevision}
  canSave={sessionSnapshot.save.canSave}
  canUndo={!renderMarkdown && sessionSnapshot.canUndo}
  canRedo={!renderMarkdown && sessionSnapshot.canRedo}
  cleanStatus={
    file.data?.truncated || (file.error && file.data === null) ? "Editing unavailable" : null
  }
  onSave={() => {
    if (session) void session.flush();
  }}
  onUndo={() => session?.undo()}
  onRedo={() => session?.redo()}
/>
```

Remove the old Saving/Saved span from the breadcrumb row.

- [ ] **Step 5: Bind EditableFileSurface to the retained editor**

Replace its coordinator construction with a required `session` prop. Use
`session.editor` for `EditProvider`, use `session.cacheKey` for the editable
`File.cacheKey`, and register the dynamic annotation callback in an effect:

```ts
useEffect(() => {
  session.setEditorChangeHandler((nextFile, nextLineAnnotations) => {
    if (!nextLineAnnotations) return;
    const remapped = remapFileCommentAnnotations(
      nextLineAnnotations as FileCommentLineAnnotation[],
    );
    setLineAnnotations(remapped);
    for (const annotation of remapped) {
      for (const entry of annotation.metadata.entries) {
        if (entry.kind !== "comment") continue;
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: session.relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text: entry.text,
            contents: nextFile.contents,
          }),
        );
      }
    }
  });
  return () => session.setEditorChangeHandler(null);
}, [addReviewComment, composerDraftTarget, session]);
```

Do not dispose the editor on surface unmount; `EditProvider` may detach it, but
the project registry owns final disposal.

- [ ] **Step 6: Preserve scoped Ctrl/Cmd+S with the session**

Replace `useExplicitFileSave` with a small `useFileSaveShortcut` that only
prevents the browser default and calls `session.flush()`:

```ts
function useFileSaveShortcut(
  containerRef: RefObject<HTMLElement | null>,
  session: { flush(): Promise<unknown> } | null,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !session) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveChord =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s";
      if (!isSaveChord) return;
      event.preventDefault();
      void session.flush();
    };
    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [containerRef, session]);
}
```

Use it in both source and rendered Markdown surfaces.

- [ ] **Step 7: Route rendered Markdown task changes through the session**

Replace the rendered surface's local coordinator with the shared session. Keep
the optimistic cache update, then call:

```ts
session.changeOutsideEditor(nextContents);
```

Pass `canUndo={false}` and `canRedo={false}` while `renderMarkdown` is true. A
rendered change intentionally creates a fresh source editor/cache key, so stale
source history cannot overwrite the Markdown change.

- [ ] **Step 8: Run the panel suite and fix only integration regressions**

Run:

```bash
vp test run apps/web/src/components/files/FilePreviewPanel.test.tsx
```

Expected: PASS, including existing comments, line reveal, Markdown, preview,
word-wrap, shortcut, and filesystem-preparation cases.

- [ ] **Step 9: Add a tab-switch history regression**

Add a focused test that renders `src/a.ts`, captures its session/editor, renders
`src/b.ts`, then renders `src/a.ts` again with the same registry. Assert:

- registry creation for `src/a.ts` happened once;
- the returned editor object is the original editor;
- `canUndo` becomes true after Pierre's `onAttach` callback;
- invoking toolbar Undo calls the original editor.

Run:

```bash
vp test run apps/web/src/components/files/FilePreviewPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Commit FilePreviewPanel integration**

```bash
git add apps/web/src/components/files/FilePreviewPanel.tsx apps/web/src/components/files/FilePreviewPanel.test.tsx
git commit -m "feat(files): connect toolbar to editing sessions"
```

---

### Task 6: Right-panel lifecycle and filesystem mutation safeguards

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx:1381-1505`
- Modify: `apps/web/src/components/ChatView.tsx:5029-5049`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx:525-527`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx:1626-1740`
- Modify: `apps/web/src/components/files/FileBrowserPanel.tsx:43-56`
- Modify: `apps/web/src/components/files/FileBrowserPanel.tsx:240-350`
- Modify: `apps/web/src/components/files/FileBrowserPanel.test.tsx:667-798`
- Modify: `apps/web/src/components/files/FilePreviewPanel.tsx:683-1013`
- Modify: `apps/web/src/components/files/FilePreviewPanel.test.tsx`

**Interfaces:**

- Consumes: `FileEditingSessionRegistry` and `FileEditingSession`.
- `FileBrowserPanel` changes
  `onBeforePathMutation` to `(relativePath: string) => Promise<boolean>`.
- `FileBrowserPanel` adds `onPathRenamed(from, to)` and
  `onPathDeleted(relativePath)`.
- `ChatView` produces one registry per active project key and passes it through
  the `editingSessions` prop.

- [ ] **Step 1: Write failing FileBrowserPanel mutation-order tests**

Update successful test callbacks to resolve `true`, then add:

```ts
it("aborts rename when pending edits cannot settle", async () => {
  setEntries([entry("src/app.ts", "file")]);
  const onBeforePathMutation = vi.fn(async () => false);
  const onPathRenamed = vi.fn();
  renderPanel(baseProps({ onBeforePathMutation, onPathRenamed }));

  rowActionsFor("src/app.ts", "file").onRename();
  (lastDialogRequest()["onSubmit"] as (name: string) => void)("renamed.ts");
  await flushPromises();

  expect(testState.commandCalls.some((call) => call.label === "renameEntry")).toBe(false);
  expect(onPathRenamed).not.toHaveBeenCalled();
});

it("notifies editing sessions after successful rename and delete", async () => {
  setEntries([entry("src/app.ts", "file")]);
  testState.commandResults["renameEntry"] = {
    _tag: "Success",
    value: { relativePath: "src/renamed.ts" },
  };
  const onPathRenamed = vi.fn();
  renderPanel(
    baseProps({
      onBeforePathMutation: vi.fn(async () => true),
      onPathRenamed,
    }),
  );
  rowActionsFor("src/app.ts", "file").onRename();
  (lastDialogRequest()["onSubmit"] as (name: string) => void)("renamed.ts");
  await flushPromises();
  expect(onPathRenamed).toHaveBeenCalledWith("src/app.ts", "src/renamed.ts");

  setEntries([entry("src/renamed.ts", "file")]);
  testState.commandResults["deleteEntry"] = { _tag: "Success", value: {} };
  const onPathDeleted = vi.fn();
  renderPanel(
    baseProps({
      onBeforePathMutation: vi.fn(async () => true),
      onPathDeleted,
    }),
  );
  rowActionsFor("src/renamed.ts", "file").onDelete();
  (lastDialogRequest()["onConfirm"] as () => void)();
  await flushPromises();
  expect(onPathDeleted).toHaveBeenCalledWith("src/renamed.ts");
});
```

Add an equivalent failed-preparation assertion for duplicate.

- [ ] **Step 2: Run FileBrowserPanel tests and verify they fail**

Run:

```bash
vp test run apps/web/src/components/files/FileBrowserPanel.test.tsx
```

Expected: FAIL because mutation preparation returns `void` and post-mutation
callbacks do not exist.

- [ ] **Step 3: Implement mutation abort and registry notifications**

Change the props:

```ts
onBeforePathMutation?: (relativePath: string) => Promise<boolean>;
onPathRenamed?: (fromRelativePath: string, toRelativePath: string) => void;
onPathDeleted?: (relativePath: string) => void;
```

Before rename, delete, and duplicate:

```ts
if (onBeforePathMutation && !(await onBeforePathMutation(relativePath))) return;
```

After successful rename, call
`onPathRenamed?.(relativePath, result.value.relativePath)` before
`remapFileSurfaces()`. After successful delete, call
`onPathDeleted?.(relativePath)` before `closeFileSurfacesUnder()`.

- [ ] **Step 4: Run FileBrowserPanel tests**

Run:

```bash
vp test run apps/web/src/components/files/FileBrowserPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Wire registry mutation callbacks from FilePreviewPanel**

Remove `activeFileSaveRef`, `registerFileSave`, and the active-only
`handleBeforePathMutation`. Pass:

```tsx
<FileBrowserPanel
  environmentId={environmentId}
  cwd={cwd}
  projectName={projectName}
  threadRef={threadRef}
  availableEditors={availableEditors}
  onOpenFile={onOpenFile}
  onBeforePathMutation={(mutationPath) =>
    editingSessions.preparePathMutation(mutationPath)
  }
  onPathRenamed={(from, to) => editingSessions.remapUnder(from, to)}
  onPathDeleted={(deletedPath) => editingSessions.removeUnder(deletedPath)}
/>
```

Update the existing panel filesystem-preparation test to assert exact and
descendant settlement through the registry double and false propagation after a
failed settle.

- [ ] **Step 6: Write a failing ChatView registry ownership test**

Change the FilePreviewPanel mock to capture props:

```tsx
vi.mock("./files/FilePreviewPanel", () => ({
  default: (props: Record<string, unknown>) => {
    h.capture("filePreviewPanel", props);
    return <div data-mock="file-preview-panel" />;
  },
}));
```

Add:

```ts
it("passes one project-scoped editing registry into file surfaces", () => {
  seedConnectedServerThread();
  useRightPanelStore.getState().openFile(threadRef, "src/a.ts");
  useRightPanelStore.getState().openFile(threadRef, "src/b.ts");
  publishSeededStoreState(useRightPanelStore);

  renderServerRoute();

  const props = capturedProps("filePreviewPanel");
  expect(props["editingSessions"]).toBeInstanceOf(FileEditingSessionRegistry);
});
```

- [ ] **Step 7: Run the ChatView hook test and verify it fails**

Run:

```bash
vp test run apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: FAIL because ChatView does not construct or pass a registry.

- [ ] **Step 8: Own and reconcile the registry in ChatView**

Import the lightweight registry class normally and session types with
`import type`. Near `activeProjectKey`, add:

```ts
const fileEditingSessions = useMemo(
  () => new FileEditingSessionRegistry<FileEditingSession<FileCommentAnnotationGroup>>(),
  [activeProjectKey, activeThreadKey],
);
const openFileRelativePaths = useMemo(
  () =>
    rightPanelState.surfaces.flatMap((surface) =>
      surface.kind === "file" ? [surface.relativePath] : [],
    ),
  [rightPanelState.surfaces],
);

useEffect(() => {
  void fileEditingSessions.reconcile(openFileRelativePaths);
}, [fileEditingSessions, openFileRelativePaths]);

useEffect(
  () => () => {
    void fileEditingSessions.dispose();
  },
  [fileEditingSessions],
);
```

Pass `editingSessions={fileEditingSessions}` to `FilePreviewPanel`.

The runtime import of `FileEditingSessionRegistry` must not import Pierre; the
editor remains inside the lazy file-preview chunk.

- [ ] **Step 9: Run lifecycle-related suites together**

Run:

```bash
vp test run \
  apps/web/src/components/files/fileEditingSessionRegistry.test.ts \
  apps/web/src/components/files/FileBrowserPanel.test.tsx \
  apps/web/src/components/files/FilePreviewPanel.test.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Commit lifecycle integration**

```bash
git add \
  apps/web/src/components/ChatView.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/components/files/FileBrowserPanel.tsx \
  apps/web/src/components/files/FileBrowserPanel.test.tsx \
  apps/web/src/components/files/FilePreviewPanel.tsx \
  apps/web/src/components/files/FilePreviewPanel.test.tsx
git commit -m "feat(files): preserve editor sessions across tabs"
```

---

### Task 7: User documentation and repository verification

**Files:**

- Modify: `docs/user/workspace-ui.md:62-72`
- Verify all files from Tasks 1-6.

**Interfaces:**

- Consumes: completed toolbar behavior and repository verification commands.
- Produces: user-facing documentation and completion evidence.

- [ ] **Step 1: Update the File Manager documentation**

Replace the final Files bullet with:

```markdown
- Autosave remains enabled. Every selected file shows a dedicated Save, Undo,
  and Redo toolbar below its breadcrumbs. Save becomes available for pending
  changes and flushes them immediately; Undo and Redo use independent native
  history for each open source file. Read-only views keep the toolbar visible
  with unavailable actions disabled. Ctrl/Cmd+S continues to flush pending
  changes.
```

- [ ] **Step 2: Run the focused File Manager suites**

Run:

```bash
vp test run \
  apps/web/src/components/files/fileSaveCoordinator.test.ts \
  apps/web/src/components/files/fileEditingSession.test.ts \
  apps/web/src/components/files/fileEditingSessionRegistry.test.ts \
  apps/web/src/components/files/FileEditorToolbar.test.tsx \
  apps/web/src/components/files/FilePreviewPanel.test.tsx \
  apps/web/src/components/files/FileBrowserPanel.test.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run repository checks**

Run:

```bash
vp check
```

Expected: PASS with no formatting, lint, or repository-policy errors.

- [ ] **Step 4: Run the required workspace typecheck**

Run:

```bash
vp run typecheck
```

Expected: PASS for every workspace package.

- [ ] **Step 5: Run the full built-in Vite+ test suite**

Run:

```bash
vp test
```

Expected: PASS.

- [ ] **Step 6: Inspect the final diff for scope and generated artifacts**

Run:

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
```

Expected: only the planned File Manager, ChatView, tests, and user
documentation are changed; `git diff --check` emits no output.

- [ ] **Step 7: Commit the documentation**

```bash
git add docs/user/workspace-ui.md
git commit -m "docs: describe file editor toolbar"
```
