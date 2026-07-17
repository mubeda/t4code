import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  value: undefined as string | undefined,
  setValue: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
  dialogs: [] as Array<Record<string, unknown>>,
  popups: [] as Array<Record<string, unknown>>,
  buttons: [] as Array<Record<string, unknown>>,
  inputs: [] as Array<Record<string, unknown>>,
  inputElement: {
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useRef: () => ({ current: harness.inputElement }),
  useState: (initial: string) => [harness.value ?? initial, harness.setValue],
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => {
    harness.inputs.push(props);
    return <input />;
  },
}));
vi.mock("../ui/dialog", () => ({
  Dialog: (props: Record<string, unknown>) => {
    harness.dialogs.push(props);
    return <div>{props.children as React.ReactNode}</div>;
  },
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPopup: (props: Record<string, unknown>) => {
    harness.popups.push(props);
    return <div>{props.children as React.ReactNode}</div>;
  },
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import FileEntryDialog, { type FileEntryDialogRequest } from "./FileEntryDialog";

function renderDialog(request: FileEntryDialogRequest | null, onClose = vi.fn()): string {
  return renderToStaticMarkup(<FileEntryDialog request={request} onClose={onClose} />);
}

function invokeClick(props: Record<string, unknown> | undefined): void {
  if (typeof props?.onClick !== "function") throw new Error("Missing click handler");
  props.onClick();
}

function button(label: string): Record<string, unknown> {
  const item = harness.buttons.find((props) => props.children === label);
  if (!item) throw new Error(`Missing button: ${label}`);
  return item;
}

beforeEach(() => {
  harness.value = undefined;
  harness.setValue.mockReset();
  harness.effects.length = 0;
  harness.dialogs.length = 0;
  harness.popups.length = 0;
  harness.buttons.length = 0;
  harness.inputs.length = 0;
  harness.inputElement = {
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FileEntryDialog", () => {
  it("closes an empty dialog only when it is dismissed", () => {
    const onClose = vi.fn();
    expect(renderDialog(null, onClose)).toBe("<div></div>");
    expect(harness.dialogs[0]?.open).toBe(false);
    const onOpenChange = harness.dialogs[0]?.onOpenChange;
    if (typeof onOpenChange !== "function") throw new Error("Missing dialog handler");
    onOpenChange(true);
    expect(onClose).not.toHaveBeenCalled();
    onOpenChange(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("focuses and selects a prompt basename after animation", () => {
    let frameCallback: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 7;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("window", { requestAnimationFrame, cancelAnimationFrame });
    const request: FileEntryDialogRequest = {
      mode: "prompt",
      title: "Rename",
      description: "Choose a new name",
      label: "Name",
      initialValue: "file.test.ts",
      confirmLabel: "Rename",
      selectBasename: true,
      onSubmit: vi.fn(),
    };
    const markup = renderDialog(request);
    expect(markup).toContain("Choose a new name");
    const cleanup = harness.effects[0]?.();
    frameCallback?.(0);
    expect(harness.inputElement.focus).toHaveBeenCalledOnce();
    expect(harness.inputElement.setSelectionRange).toHaveBeenCalledWith(0, 9);
    expect(harness.inputElement.select).not.toHaveBeenCalled();
    if (typeof cleanup === "function") cleanup();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
  });

  it("selects a whole prompt value and tolerates a missing input", () => {
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 8;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const request: FileEntryDialogRequest = {
      mode: "prompt",
      title: "New file",
      label: "Name",
      initialValue: "README",
      confirmLabel: "Create",
      selectBasename: true,
      onSubmit: vi.fn(),
    };
    renderDialog(request);
    harness.effects[0]?.();
    frameCallback?.(0);
    expect(harness.inputElement.select).toHaveBeenCalledOnce();

    harness.effects.length = 0;
    harness.inputElement = null as never;
    renderDialog({ ...request, selectBasename: false });
    harness.effects[0]?.();
    frameCallback?.(0);
  });

  it("submits a trimmed prompt through clicks and keyboard input", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    harness.value = "  notes.md  ";
    renderDialog(
      {
        mode: "prompt",
        title: "New file",
        label: "Name",
        initialValue: "",
        confirmLabel: "Create",
        onSubmit,
      },
      onClose,
    );
    expect(button("Create").disabled).toBe(false);
    invokeClick(button("Create"));
    expect(onSubmit).toHaveBeenCalledWith("notes.md");
    expect(onClose).toHaveBeenCalledOnce();

    const onChange = harness.inputs[0]?.onChange;
    if (typeof onChange !== "function") throw new Error("Missing input handler");
    onChange({ target: { value: "other.md" } });
    expect(harness.setValue).toHaveBeenCalledWith("other.md");

    const onKeyDown = harness.popups[0]?.onKeyDown;
    if (typeof onKeyDown !== "function") throw new Error("Missing key handler");
    const enter = { key: "Enter", shiftKey: false, preventDefault: vi.fn() };
    onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    onKeyDown({ key: "Enter", shiftKey: true, preventDefault: vi.fn() });
    onKeyDown({ key: "Escape", shiftKey: false, preventDefault: vi.fn() });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("blocks blank prompt submissions", () => {
    const onSubmit = vi.fn();
    harness.value = "   ";
    renderDialog({
      mode: "prompt",
      title: "New folder",
      label: "Name",
      initialValue: "",
      confirmLabel: "Create",
      onSubmit,
    });
    expect(button("Create").disabled).toBe(true);
    invokeClick(button("Create"));
    const onKeyDown = harness.popups[0]?.onKeyDown;
    if (typeof onKeyDown !== "function") throw new Error("Missing key handler");
    const enter = { key: "Enter", shiftKey: false, preventDefault: vi.fn() };
    onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("confirms destructive and ordinary actions", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const destructive: FileEntryDialogRequest = {
      mode: "confirm",
      title: "Delete file",
      description: "This cannot be undone",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm,
    };
    renderDialog(destructive, onClose);
    expect(harness.effects[0]?.()).toBeUndefined();
    expect(button("Delete").variant).toBe("destructive");
    invokeClick(button("Delete"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    harness.buttons.length = 0;
    harness.effects.length = 0;
    renderDialog({ ...destructive, destructive: false, confirmLabel: "Continue" });
    expect(button("Continue").variant).toBe("default");
    invokeClick(button("Cancel"));
  });
});
