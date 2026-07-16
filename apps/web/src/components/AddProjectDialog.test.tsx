// @vitest-environment happy-dom

import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t4code/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface BrowseEntry {
  readonly name: string;
  readonly fullPath: string;
}

const testState = vi.hoisted(() => ({
  primaryEnvironment: null as {
    environmentId: EnvironmentId;
  } | null,
  browseByPath: new Map<string, { data?: { entries: BrowseEntry[] }; isPending: boolean }>(),
  createProject: vi.fn(),
  cloneRepo: vi.fn(),
  toasts: [] as Array<Record<string, unknown>>,
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => testState.primaryEnvironment,
}));

vi.mock("~/state/filesystem", () => ({
  filesystemEnvironment: {
    browse: (args: unknown) => ({ kind: "browse", args }),
  },
}));

vi.mock("~/state/projects", () => ({ projectEnvironment: { create: "create-project" } }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { clone: "clone-repo" } }));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (descriptor: { args?: { input?: { partialPath?: string } } } | null) => {
    if (!descriptor) return { data: undefined, isPending: false };
    const path = descriptor.args?.input?.partialPath ?? "";
    return testState.browseByPath.get(path) ?? { data: undefined, isPending: true };
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "create-project" ? testState.createProject : testState.cloneRepo,
}));

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: Record<string, unknown>) => toast,
  toastManager: {
    add: (toast: Record<string, unknown>) => {
      testState.toasts.push(toast);
      return "toast-id";
    },
  },
}));

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

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
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
  testState.primaryEnvironment = { environmentId: EnvironmentId.make("local-test") };
  testState.browseByPath = new Map([["~", { data: { entries: [] }, isPending: false }]]);
  testState.createProject.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.cloneRepo.mockReset().mockResolvedValue(AsyncResult.success({ path: "/repos/cloned" }));
  testState.toasts = [];
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
  it("renders an open dialog, navigates folders, and creates the selected project", async () => {
    testState.browseByPath.set("~", {
      data: { entries: [{ name: "projects", fullPath: "/projects" }] },
      isPending: false,
    });
    testState.browseByPath.set("~projects/", {
      data: { entries: [{ name: ".git", fullPath: "/projects/.git" }] },
      isPending: false,
    });
    const onOpenChange = vi.fn();

    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);

    await click(buttonWithText("projects"));
    expect(document.querySelector<HTMLInputElement>("input:not([placeholder])")?.value).toBe(
      "~projects/",
    );
    expect(document.body.textContent).toContain("This folder is a git repository.");

    await click(buttonWithText("Add project"));
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: EnvironmentId.make("local-test"),
        input: expect.objectContaining({ workspaceRoot: "~projects/" }),
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("selects discovered repositories through rendered checkboxes before importing", async () => {
    testState.browseByPath.set("~", {
      data: {
        entries: [
          { name: "alpha", fullPath: "/repos/alpha" },
          { name: "notes", fullPath: "/repos/notes" },
        ],
      },
      isPending: false,
    });
    testState.browseByPath.set("/repos/alpha", {
      data: { entries: [{ name: ".git", fullPath: "/repos/alpha/.git" }] },
      isPending: false,
    });
    testState.browseByPath.set("/repos/notes", {
      data: { entries: [{ name: "readme.txt", fullPath: "/repos/notes/readme.txt" }] },
      isPending: false,
    });
    const onOpenChange = vi.fn();

    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox?.closest("label")?.textContent).toContain("alpha");

    await click(checkbox!);
    expect(checkbox?.checked).toBe(true);
    await click(buttonWithText("Import 1 selected"));

    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ workspaceRoot: "/repos/alpha" }),
      }),
    );
    expect(testState.toasts).toContainEqual(
      expect.objectContaining({ type: "success", title: "Added 1 project" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clones from the URL typed into the rendered input and adds the clone", async () => {
    const onOpenChange = vi.fn();
    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);
    const cloneInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="https://github.com/org/repo.git"]',
    );
    expect(cloneInput).not.toBeNull();

    await changeInput(cloneInput!, " https://example.test/repo.git ");
    await click(buttonWithText("Clone"));

    expect(testState.cloneRepo).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("local-test"),
      input: { url: "https://example.test/repo.git", parentDir: "~" },
    });
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ workspaceRoot: "/repos/cloned" }),
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses the local fallback environment and reports create failures without closing", async () => {
    testState.primaryEnvironment = null;
    testState.browseByPath.set("~", {
      data: { entries: [{ name: ".git", fullPath: "~/.git" }] },
      isPending: false,
    });
    testState.createProject
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("disk full"))))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("opaque failure")))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
    const onOpenChange = vi.fn();
    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);

    await click(buttonWithText("Add project"));
    await click(buttonWithText("Add project"));
    await click(buttonWithText("Add project"));

    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
      }),
    );
    expect(testState.toasts).toEqual([
      expect.objectContaining({ type: "error", description: "disk full" }),
      expect.objectContaining({ type: "error", description: "An error occurred." }),
    ]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("reports clone failures and keeps a successfully cloned project open when adding fails", async () => {
    const onOpenChange = vi.fn();
    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);
    const cloneInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="https://github.com/org/repo.git"]',
    );
    expect(cloneInput).not.toBeNull();
    await changeInput(cloneInput!, "https://example.test/repo.git");

    testState.cloneRepo.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("network down"))),
    );
    await click(buttonWithText("Clone"));
    testState.cloneRepo.mockResolvedValueOnce(AsyncResult.failure(Cause.fail("opaque clone")));
    await click(buttonWithText("Clone"));
    testState.cloneRepo.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
    await click(buttonWithText("Clone"));

    testState.cloneRepo.mockResolvedValueOnce(AsyncResult.success({ path: "/repos/cloned" }));
    testState.createProject.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("cannot register"))),
    );
    await click(buttonWithText("Clone"));

    expect(testState.toasts).toEqual([
      expect.objectContaining({ type: "error", description: "network down" }),
      expect.objectContaining({ type: "error", description: "An error occurred." }),
      expect.objectContaining({ type: "error", description: "cannot register" }),
    ]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("imports multiple scanned repositories, supports deselection, and reports partial success", async () => {
    testState.browseByPath.set("~", {
      data: {
        entries: [
          { name: "alpha", fullPath: "/repos/alpha" },
          { name: "beta", fullPath: "/repos/beta" },
        ],
      },
      isPending: false,
    });
    for (const path of ["/repos/alpha", "/repos/beta"]) {
      testState.browseByPath.set(path, {
        data: { entries: [{ name: ".git", fullPath: `${path}/.git` }] },
        isPending: false,
      });
    }
    const onOpenChange = vi.fn();
    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes).toHaveLength(2);

    await click(checkboxes[0]!);
    await click(checkboxes[0]!);
    expect(checkboxes[0]?.checked).toBe(false);
    await click(checkboxes[0]!);
    await click(checkboxes[1]!);

    testState.createProject
      .mockResolvedValueOnce(AsyncResult.success(undefined))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("cannot add beta")));
    await click(buttonWithText("Import 2 selected"));
    expect(testState.toasts).toContainEqual(
      expect.objectContaining({ type: "success", title: "Added 1 project" }),
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    testState.createProject.mockResolvedValue(AsyncResult.success(undefined));
    await click(buttonWithText("Import 2 selected"));
    expect(testState.toasts).toContainEqual(
      expect.objectContaining({ type: "success", title: "Added 2 projects" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders pending child scans and navigates up without committing a project", async () => {
    testState.browseByPath.set("~", {
      data: { entries: [{ name: "pending", fullPath: "/repos/pending" }] },
      isPending: false,
    });
    testState.browseByPath.set("/repos/pending", { isPending: true });
    const onOpenChange = vi.fn();
    await mount(<AddProjectDialog open onOpenChange={onOpenChange} />);
    expect(document.body.textContent).toContain("Scanning pending...");

    const folderInput = document.querySelector<HTMLInputElement>('input:not([placeholder])');
    expect(folderInput).not.toBeNull();
    await changeInput(folderInput!, "/repos/pending/");
    await click(buttonWithText("Up"));
    expect(folderInput?.value).toBe("/repos/");
    expect(testState.createProject).not.toHaveBeenCalled();
  });
});
