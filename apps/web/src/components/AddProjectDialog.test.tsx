// @vitest-environment happy-dom

import { EnvironmentId } from "@t4code/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AddProjectWorkflow } from "./add-project/useAddProjectWorkflow";

type MutableAddProjectWorkflow = {
  -readonly [Key in keyof AddProjectWorkflow]: AddProjectWorkflow[Key];
};

const testState = vi.hoisted(() => ({
  workflow: null as unknown as MutableAddProjectWorkflow,
}));

vi.mock("./add-project/useAddProjectWorkflow", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useAddProjectWorkflow: () => {
      const [step, setStep] = React.useState(testState.workflow.step);
      return {
        ...testState.workflow,
        step,
        back: () => {
          testState.workflow.back();
          setStep("start");
        },
        openClone: () => {
          testState.workflow.openClone();
          setStep("clone");
        },
        openCreate: () => {
          testState.workflow.openCreate();
          setStep("create");
        },
      };
    },
  };
});

import { AddProjectDialog } from "./AddProjectDialog";

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
const suiteGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "getAnimations",
);
let originalGetAnimationsDescriptor: PropertyDescriptor | undefined;

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedTrees.push({ container, root });
  await act(async () => root.render(element));
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((entry) =>
    entry.textContent?.includes(text),
  );
  expect(button).toBeDefined();
  return button!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getAnimations",
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });

  const environmentId = EnvironmentId.make("local-test");
  const selectedHost = {
    environmentId,
    label: "This device",
    platform: "MacIntel",
    baseDirectory: "~/",
    isPrimary: true,
    desktopInstanceId: null,
    nativePickerAvailable: true,
  } as const;
  testState.workflow = {
    hosts: [selectedHost],
    selectedHost,
    step: "start",
    busy: false,
    hostPath: "~/",
    cloneUrl: "",
    cloneParent: "~/",
    createName: "",
    createParent: "~/",
    error: null,
    canPickParent: true,
    selectHost: vi.fn(),
    back: vi.fn(),
    browse: vi.fn(async () => {}),
    setHostPath: vi.fn(),
    submitHostPath: vi.fn(async () => {}),
    openClone: vi.fn(),
    setCloneUrl: vi.fn(),
    setCloneParent: vi.fn(),
    pickCloneParent: vi.fn(async () => {}),
    submitClone: vi.fn(async () => {}),
    openCreate: vi.fn(),
    setCreateName: vi.fn(),
    setCreateParent: vi.fn(),
    pickCreateParent: vi.fn(async () => {}),
    submitCreate: vi.fn(async () => {}),
  };
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  if (originalGetAnimationsDescriptor) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimationsDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  originalGetAnimationsDescriptor = undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations")).toEqual(
    suiteGetAnimationsDescriptor,
  );
});

describe("AddProjectDialog mounted interactions", () => {
  it("renders the start step and opens clone and create steps", async () => {
    await mount(<AddProjectDialog open onOpenChange={vi.fn()} />);
    expect(document.body.textContent).toContain("Add a project");

    await click(buttonWithText("Clone from URL"));
    expect(document.body.textContent).toContain("Enter the Git URL and choose where to clone it.");
    await click(buttonWithText("Back"));

    await click(buttonWithText("Create new project"));
    expect(document.body.textContent).toContain(
      "Name it and T4Code will create a real project with sensible defaults.",
    );
  });

  it("names and describes the dialog and keeps step content padded and scrollable", async () => {
    await mount(<AddProjectDialog open onOpenChange={vi.fn()} />);

    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("Missing add project dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(labelledBy).not.toBeNull();
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Add a project");
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "Choose how to add a project",
    );

    const content = dialog.querySelector('[data-add-project-content="true"]');
    expect(content?.classList.contains("overflow-y-auto")).toBe(true);
    expect(content?.classList.contains("px-6")).toBe(true);
  });

  it("never renders nested repository import UI", async () => {
    await mount(<AddProjectDialog open onOpenChange={vi.fn()} />);
    expect(document.body.textContent).not.toContain("Repositories found");
    expect(document.body.textContent).not.toContain("Import selected");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("prevents dismissal while a mutation is pending", async () => {
    testState.workflow.busy = true;
    const onOpenChange = vi.fn();
    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);
    await pressEscape();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
