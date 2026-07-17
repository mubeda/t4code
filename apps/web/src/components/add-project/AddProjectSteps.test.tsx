// @vitest-environment happy-dom

import { EnvironmentId } from "@t4code/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AddProjectCloneStep,
  AddProjectCreateStep,
  AddProjectHostPathStep,
  AddProjectStartStep,
  type AddProjectStartStepProps,
} from "./AddProjectSteps";
import type { AddProjectHostOption } from "./AddProjectDialog.logic";

const roots: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = [];

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(element));
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

async function keyDown(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const localHost: AddProjectHostOption = {
  environmentId: EnvironmentId.make("local"),
  label: "Local Mac",
  platform: "MacIntel",
  baseDirectory: "~/",
  isPrimary: true,
  desktopInstanceId: null,
  nativePickerAvailable: true,
};

const remoteHost: AddProjectHostOption = {
  environmentId: EnvironmentId.make("remote"),
  label: "Build server",
  platform: "Linux",
  baseDirectory: "/srv/code/",
  isPrimary: false,
  desktopInstanceId: null,
  nativePickerAvailable: true,
};

async function mountLauncher(overrides: Partial<AddProjectStartStepProps> = {}): Promise<void> {
  await mount(
    <AddProjectStartStep
      hosts={[localHost, remoteHost]}
      selectedEnvironmentId={localHost.environmentId}
      busy={false}
      error={null}
      onSelectHost={vi.fn()}
      onBrowse={vi.fn()}
      onOpenClone={vi.fn()}
      onOpenCreate={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of roots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

describe("Add Project presentational steps", () => {
  it("renders the Orca launcher without nested import controls", async () => {
    await mount(
      <AddProjectStartStep
        hosts={[localHost, remoteHost]}
        selectedEnvironmentId={localHost.environmentId}
        busy={false}
        error={null}
        onSelectHost={vi.fn()}
        onBrowse={vi.fn()}
        onOpenClone={vi.fn()}
        onOpenCreate={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("Add a project");
    expect(document.body.textContent).toContain("Browse folder");
    expect(document.body.textContent).toContain("Other ways to add");
    expect(document.body.textContent).toContain("Clone from URL");
    expect(document.body.textContent).toContain("Create new project");
    expect(document.body.textContent).not.toContain("Repositories found");
    expect(document.body.textContent).not.toContain("Import selected");
  });

  it("moves launcher focus with arrow keys and activates with Enter", async () => {
    const onOpenClone = vi.fn();
    await mountLauncher({ onOpenClone });
    const browse = buttonWithText("Browse folder");
    const clone = buttonWithText("Clone from URL");

    expect(document.activeElement).toBe(browse);
    await keyDown(browse, "ArrowDown");
    expect(document.activeElement).toBe(clone);
    await keyDown(clone, "Enter");
    expect(onOpenClone).toHaveBeenCalledTimes(1);
  });

  it("activates the focused launcher action with Space", async () => {
    const onOpenClone = vi.fn();
    await mountLauncher({ onOpenClone });
    const browse = buttonWithText("Browse folder");
    const clone = buttonWithText("Clone from URL");

    await keyDown(browse, "ArrowDown");
    expect(document.activeElement).toBe(clone);
    await keyDown(clone, " ");
    expect(onOpenClone).toHaveBeenCalledTimes(1);
  });

  it("suppresses launcher actions while busy", async () => {
    const onBrowse = vi.fn();
    const onOpenClone = vi.fn();
    const onOpenCreate = vi.fn();
    await mountLauncher({ busy: true, onBrowse, onOpenClone, onOpenCreate });

    for (const title of ["Browse folder", "Clone from URL", "Create new project"]) {
      const action = buttonWithText(title);
      expect(action.disabled).toBe(true);
      await click(action);
      await keyDown(action, "Enter");
      await keyDown(action, " ");
    }
    expect(onBrowse).not.toHaveBeenCalled();
    expect(onOpenClone).not.toHaveBeenCalled();
    expect(onOpenCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("↵");
    expect(buttonWithText("Local Mac").disabled).toBe(true);
  });

  it("wraps launcher focus at both ends", async () => {
    await mountLauncher();
    const browse = buttonWithText("Browse folder");
    const create = buttonWithText("Create new project");

    await keyDown(browse, "ArrowUp");
    expect(document.activeElement).toBe(create);
    await keyDown(create, "ArrowDown");
    expect(document.activeElement).toBe(browse);
  });

  it("always labels the host selector and disables it for one host", async () => {
    await mountLauncher({ hosts: [localHost] });

    expect(document.body.textContent).toContain("Host");
    expect(buttonWithText("Local Mac").disabled).toBe(true);
  });

  it("renders launcher failures as an accessible alert", async () => {
    await mountLauncher({
      error: "Start the matching WSL backend, then choose the folder again.",
    } as Partial<AddProjectStartStepProps>);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Start the matching WSL backend");
  });

  it("submits a non-empty host path with Enter", async () => {
    const onSubmit = vi.fn();
    await mount(
      <AddProjectHostPathStep
        hostLabel="Build server"
        path="/srv/code/demo"
        error={null}
        busy={false}
        onPathChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing host path input");

    expect(document.body.textContent).toContain("Open project folder");
    expect(document.body.textContent).toContain("Build server");
    expect(buttonWithText("Open project")).toBeDefined();
    await keyDown(input, "Enter");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows controlled clone fields and disables submit until valid", async () => {
    const onClone = vi.fn();
    await mount(
      <AddProjectCloneStep
        url=""
        parentDir="~/"
        platform="Linux"
        error={null}
        busy={false}
        canPickParent
        onUrlChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onClone={onClone}
      />,
    );
    expect(buttonWithText("Clone").disabled).toBe(true);
  });

  it("shows a local error and blocks a non-empty invalid clone URL", async () => {
    const onClone = vi.fn();
    await mount(
      <AddProjectCloneStep
        url="not-a-url"
        parentDir="~/projects/"
        platform="Linux"
        error="Remote clone failed."
        busy={false}
        canPickParent
        onUrlChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onClone={onClone}
      />,
    );

    expect(document.body.textContent).toContain("Enter a valid Git repository URL.");
    expect(document.body.textContent).toContain("Remote clone failed.");
    expect(buttonWithText("Clone").disabled).toBe(true);
    const urlInput = document.querySelector<HTMLInputElement>("#add-project-clone-url");
    if (!urlInput) throw new Error("Missing Git URL input");
    expect(urlInput.getAttribute("aria-invalid")).toBe("true");
    await keyDown(urlInput, "Enter");
    expect(onClone).not.toHaveBeenCalled();
  });

  it("shows a field error and blocks a relative clone parent", async () => {
    const onClone = vi.fn();
    await mount(
      <AddProjectCloneStep
        url="git@github.com:openai/codex.git"
        parentDir="projects"
        platform="Linux"
        error={null}
        busy={false}
        canPickParent
        onUrlChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onClone={onClone}
      />,
    );

    expect(document.body.textContent).toContain("Enter an absolute or home-relative path.");
    expect(buttonWithText("Clone").disabled).toBe(true);
    const parentInput = document.querySelector<HTMLInputElement>("#add-project-clone-parent");
    if (!parentInput) throw new Error("Missing clone parent input");
    expect(parentInput.getAttribute("aria-invalid")).toBe("true");
    await keyDown(parentInput, "Enter");
    expect(onClone).not.toHaveBeenCalled();
  });

  it("submits valid clone fields with Enter", async () => {
    const onClone = vi.fn();
    await mount(
      <AddProjectCloneStep
        url="https://github.com/openai/codex.git"
        parentDir="~/projects/"
        platform="Linux"
        error={null}
        busy={false}
        canPickParent={false}
        onUrlChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onClone={onClone}
      />,
    );
    const urlInput = document.querySelector("input");
    if (!(urlInput instanceof HTMLInputElement)) throw new Error("Missing Git URL input");

    await keyDown(urlInput, "Enter");
    expect(onClone).toHaveBeenCalledTimes(1);
  });

  it("hides the clone parent picker when the host cannot route it", async () => {
    await mount(
      <AddProjectCloneStep
        url="https://github.com/openai/codex.git"
        parentDir="~/projects/"
        platform="Linux"
        error={null}
        busy={false}
        canPickParent={false}
        onUrlChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onClone={vi.fn()}
      />,
    );

    expect(document.querySelector('[aria-label="Choose parent folder"]')).toBeNull();
  });

  it("disables clone while the selected host platform is not ready", async () => {
    const onClone = vi.fn();
    await mount(
      <AddProjectCloneStep
        url="https://github.com/openai/codex.git"
        parentDir="~/projects/"
        platform={null}
        error={null}
        busy={false}
        canPickParent={false}
        onUrlChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onClone={onClone}
      />,
    );

    expect(document.body.textContent).toContain("Host platform information is still loading.");
    expect(buttonWithText("Clone").disabled).toBe(true);
  });

  it("suppresses clone submission while busy", async () => {
    const onClone = vi.fn();
    await mount(
      <AddProjectCloneStep
        url="https://github.com/openai/codex.git"
        parentDir="~/projects/"
        platform="Linux"
        error={null}
        busy
        canPickParent
        onUrlChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onClone={onClone}
      />,
    );
    const form = document.querySelector("form");
    const urlInput = document.querySelector<HTMLInputElement>("#add-project-clone-url");
    if (!(form instanceof HTMLFormElement) || !urlInput) throw new Error("Missing clone form");

    expect(buttonWithText("Cloning…").disabled).toBe(true);
    await keyDown(urlInput, "Enter");
    await submit(form);
    expect(onClone).not.toHaveBeenCalled();
  });

  it("shows T4Code create copy and target summary", async () => {
    await mount(
      <AddProjectCreateStep
        name="demo"
        parentDir="~/projects/"
        platform="Linux"
        error={null}
        busy={false}
        canPickParent
        onNameChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain(
      "Name it and T4Code will create a real project with sensible defaults.",
    );
    expect(document.body.textContent).toContain("Git repository in ~/projects");
    expect(document.body.textContent).toContain("~/projects/demo");
  });

  it("keeps create parent controls collapsed until the summary is expanded", async () => {
    await mount(
      <AddProjectCreateStep
        name="demo"
        parentDir="~/projects/"
        platform="Linux"
        error={null}
        busy={false}
        canPickParent
        onNameChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const summary = buttonWithText("Git repository in ~/projects");

    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("Parent folder");
    await click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Parent folder");
  });

  it("suppresses create submission while busy", async () => {
    const onCreate = vi.fn();
    await mount(
      <AddProjectCreateStep
        name="demo"
        parentDir="~/projects/"
        platform="Linux"
        error={null}
        busy
        canPickParent
        onNameChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onCreate={onCreate}
      />,
    );
    const form = document.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Missing create form");

    expect(buttonWithText("Creating…").disabled).toBe(true);
    await submit(form);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("disables create while the selected host platform is not ready", async () => {
    await mount(
      <AddProjectCreateStep
        name="demo"
        parentDir="~/projects/"
        platform={null}
        error={null}
        busy={false}
        canPickParent={false}
        onNameChange={vi.fn()}
        onParentDirChange={vi.fn()}
        onPickParent={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(buttonWithText("Create project").disabled).toBe(true);
  });
});
