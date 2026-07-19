// @vitest-environment happy-dom

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
