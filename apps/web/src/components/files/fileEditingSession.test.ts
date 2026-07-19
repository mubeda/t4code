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
});
