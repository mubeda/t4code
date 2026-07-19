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
import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  it("keeps autosaving after its editor change handler is cleared", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => AsyncResult.success(undefined));
    const handler = vi.fn();
    const session = new FileEditingSession({
      cwd: "/repo",
      relativePath: "src/app.ts",
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    const editor = session.editor as unknown as InstanceType<typeof pierre.Editor>;
    const onChange = editor.options["onChange"] as (file: { contents: string }) => void;

    session.setEditorChangeHandler(handler);
    onChange({ contents: "with handler" });

    expect(handler).toHaveBeenCalledWith({ contents: "with handler" }, undefined);
    expect(session.getSnapshot().save.phase).toBe("pending");

    session.setEditorChangeHandler(null);
    onChange({ contents: "without handler" });
    await vi.advanceTimersByTimeAsync(500);

    expect(handler).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("src/app.ts", "without handler");
  });

  it("holds edits during a delayed rename and saves them to the renamed path after release", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => AsyncResult.success(undefined));
    const registry = new FileEditingSessionRegistry<FileEditingSession<never>>();
    const session = registry.getOrCreate(
      "src/old.ts",
      () =>
        new FileEditingSession({
          cwd: "/repo",
          relativePath: "src/old.ts",
          debounceMs: 500,
          persist,
          onPendingChange: vi.fn(),
          onConfirmed: vi.fn(),
        }),
    );
    const editor = session.editor as unknown as InstanceType<typeof pierre.Editor>;
    const command = deferred();
    const lease = await registry.beginPathMutation("src/old.ts");
    expect(lease).not.toBeNull();

    const mutation = command.promise.then(() => {
      lease!.commitRename("src/new.ts");
      lease!.release();
    });
    (editor.options["onChange"] as (file: { contents: string }) => void)({
      contents: "edited during rename",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).not.toHaveBeenCalled();

    command.resolve();
    await mutation;
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("src/new.ts", "edited during rename");
  });

  it("releases edits to the original path after a delayed rename fails", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => AsyncResult.success(undefined));
    const registry = new FileEditingSessionRegistry<FileEditingSession<never>>();
    const session = registry.getOrCreate(
      "src/old.ts",
      () =>
        new FileEditingSession({
          cwd: "/repo",
          relativePath: "src/old.ts",
          debounceMs: 500,
          persist,
          onPendingChange: vi.fn(),
          onConfirmed: vi.fn(),
        }),
    );
    const editor = session.editor as unknown as InstanceType<typeof pierre.Editor>;
    const command = deferred();
    const lease = await registry.beginPathMutation("src/old.ts");
    expect(lease).not.toBeNull();

    const mutation = command.promise.then(() => lease!.release());
    (editor.options["onChange"] as (file: { contents: string }) => void)({
      contents: "edited during failed rename",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).not.toHaveBeenCalled();

    command.resolve();
    await mutation;
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledWith("src/old.ts", "edited during failed rename");
  });

  it("discards edits made during a delayed delete", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => AsyncResult.success(undefined));
    const registry = new FileEditingSessionRegistry<FileEditingSession<never>>();
    const session = registry.getOrCreate(
      "src/app.ts",
      () =>
        new FileEditingSession({
          cwd: "/repo",
          relativePath: "src/app.ts",
          debounceMs: 500,
          persist,
          onPendingChange: vi.fn(),
          onConfirmed: vi.fn(),
        }),
    );
    const editor = session.editor as unknown as InstanceType<typeof pierre.Editor>;
    const command = deferred();
    const lease = await registry.beginPathMutation("src/app.ts");
    expect(lease).not.toBeNull();

    const mutation = command.promise.then(() => {
      lease!.commitDelete();
      lease!.release();
    });
    (editor.options["onChange"] as (file: { contents: string }) => void)({
      contents: "must be discarded",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).not.toHaveBeenCalled();

    command.resolve();
    await mutation;
    await vi.runAllTimersAsync();
    expect(persist).not.toHaveBeenCalled();
    expect(registry.get("src/app.ts")).toBeUndefined();
    expect(editor.cleanUp).toHaveBeenCalledOnce();
  });

  it("does not pause autosaves for sessions outside the mutation path", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => AsyncResult.success(undefined));
    const registry = new FileEditingSessionRegistry<FileEditingSession<never>>();
    const createSession = (relativePath: string) =>
      new FileEditingSession<never>({
        cwd: "/repo",
        relativePath,
        debounceMs: 500,
        persist,
        onPendingChange: vi.fn(),
        onConfirmed: vi.fn(),
      });
    const affected = registry.getOrCreate("src/app.ts", () => createSession("src/app.ts"));
    const unrelated = registry.getOrCreate("docs/readme.md", () => createSession("docs/readme.md"));
    const lease = await registry.beginPathMutation("src");
    expect(lease).not.toBeNull();

    const affectedEditor = affected.editor as unknown as InstanceType<typeof pierre.Editor>;
    const unrelatedEditor = unrelated.editor as unknown as InstanceType<typeof pierre.Editor>;
    (affectedEditor.options["onChange"] as (file: { contents: string }) => void)({
      contents: "affected",
    });
    (unrelatedEditor.options["onChange"] as (file: { contents: string }) => void)({
      contents: "unrelated",
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("docs/readme.md", "unrelated");
    lease!.release();
  });
});
