// @vitest-environment happy-dom

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t4code/contracts";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  setProviderModelOptions: vi.fn(),
}));

vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: unknown) => unknown) =>
    selector({ setProviderModelOptions: testState.setProviderModelOptions }),
}));

import { shouldRenderTraitsControls, TraitsPicker } from "./TraitsPicker";

const MODEL = "test-model";
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

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

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id,
    label,
    type: "select",
    options,
    ...(promptInjectedValues ? { promptInjectedValues } : {}),
  };
}

function booleanDescriptor(
  id: string,
  label: string,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id, label, type: "boolean" };
}

function modelsWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    {
      slug: MODEL,
      name: "Test Model",
      isCustom: false,
      capabilities: { optionDescriptors: descriptors },
    },
  ];
}

function selections(...entries: Array<[string, string | boolean]>): ProviderOptionSelection[] {
  return entries.map(([id, value]) => ({ id, value }));
}

function NoPersistenceHarness() {
  const [prompt, setPrompt] = useState("");
  return (
    <>
      <TraitsPicker
        provider={CLAUDE}
        models={modelsWith([effort, booleanDescriptor("thinking", "Thinking")])}
        model={MODEL}
        prompt={prompt}
        onPromptChange={setPrompt}
      />
      <output data-testid="prompt">{prompt}</output>
    </>
  );
}

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  await act(async () => root.render(element));
  return mounted;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  expect(button).toBeDefined();
  return button!;
}

function radioItem(label: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitemradio']")).find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  expect(item).toBeDefined();
  return item!;
}

const effort = selectDescriptor(
  "effort",
  "Effort",
  [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  ["ultrathink"],
);

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
  testState.setProviderModelOptions.mockReset();
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
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations")).toEqual(
    suiteGetAnimationsDescriptor,
  );
});

describe("TraitsPicker", () => {
  it("reports and renders controls only for models with option descriptors", async () => {
    expect(
      shouldRenderTraitsControls({
        provider: CODEX,
        models: modelsWith([]),
        model: MODEL,
        prompt: "",
        modelOptions: [],
      }),
    ).toBe(false);
    expect(
      shouldRenderTraitsControls({
        provider: CODEX,
        models: modelsWith([effort]),
        model: MODEL,
        prompt: "",
        modelOptions: [],
      }),
    ).toBe(true);

    await mount(
      <TraitsPicker
        provider={CODEX}
        models={modelsWith([])}
        model={MODEL}
        prompt=""
        onPromptChange={vi.fn()}
        onModelOptionsChange={vi.fn()}
      />,
    );
    expect(document.body.textContent).toBe("");
  });

  it("shows current select and boolean labels and changes a select through the open menu", async () => {
    const onModelOptionsChange = vi.fn();
    const models = modelsWith([
      effort,
      selectDescriptor("contextWindow", "Context Window", [
        { id: "200k", label: "200k", isDefault: true },
        { id: "1m", label: "1M" },
      ]),
      booleanDescriptor("fastMode", "Fast Mode"),
      booleanDescriptor("thinking", "Thinking"),
    ]);
    await mount(
      <TraitsPicker
        provider={CODEX}
        models={models}
        model={MODEL}
        prompt=""
        modelOptions={selections(["effort", "high"], ["fastMode", false], ["thinking", true])}
        onPromptChange={vi.fn()}
        onModelOptionsChange={onModelOptionsChange}
        triggerClassName="test-trigger"
        triggerVariant="outline"
      />,
    );

    const trigger = buttonContaining("High");
    expect(trigger.textContent).toContain("200k");
    expect(trigger.textContent).toContain("Normal");
    expect(trigger.textContent).toContain("Thinking On");
    expect(trigger.className).toContain("test-trigger");

    await click(trigger);
    await click(radioItem("Low"));
    expect(onModelOptionsChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "effort", value: "low" })]),
    );
  });

  it("shows configured Codex Fast through partial and empty capability snapshots", async () => {
    const partialModels = modelsWith([
      selectDescriptor("reasoningEffort", "Reasoning", [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ]),
      selectDescriptor("serviceTier", "Service Tier", [
        { id: "default", label: "Standard", isDefault: true },
      ]),
    ]);
    const modelOptions = selections(["reasoningEffort", "high"], ["serviceTier", "fast"]);
    expect(
      shouldRenderTraitsControls({
        provider: CODEX,
        models: modelsWith([]),
        model: MODEL,
        prompt: "",
        modelOptions: selections(["serviceTier", "fast"]),
      }),
    ).toBe(true);

    await mount(
      <TraitsPicker
        provider={CODEX}
        models={partialModels}
        model={MODEL}
        prompt=""
        modelOptions={modelOptions}
        onPromptChange={vi.fn()}
        onModelOptionsChange={vi.fn()}
      />,
    );

    const trigger = buttonContaining("High");
    expect(trigger.textContent).toContain("Fast");
    await click(trigger);
    expect(radioItem("Standard")).toBeDefined();
    expect(radioItem("Fast")).toBeDefined();
  });

  it("injects ultrathink into an empty prompt from the rendered option", async () => {
    const onPromptChange = vi.fn();
    await mount(
      <TraitsPicker
        provider={CLAUDE}
        models={modelsWith([effort])}
        model={MODEL}
        prompt="   "
        onPromptChange={onPromptChange}
        onModelOptionsChange={vi.fn()}
      />,
    );

    await click(buttonContaining("High"));
    await click(radioItem("Ultrathink"));
    expect(onPromptChange).toHaveBeenCalledWith("Ultrathink:\n");
  });

  it("shows a raw prompt-injected session default as the selected effort", async () => {
    await mount(
      <TraitsPicker
        provider={CLAUDE}
        models={modelsWith([effort])}
        model={MODEL}
        prompt=""
        modelOptions={selections(["effort", "ultrathink"])}
        onPromptChange={vi.fn()}
        onModelOptionsChange={vi.fn()}
      />,
    );

    const trigger = buttonContaining("Ultrathink");
    await click(trigger);
    expect(radioItem("Ultrathink").getAttribute("aria-checked")).toBe("true");
  });

  it("replaces a raw prompt-injected session default with a native effort", async () => {
    const onPromptChange = vi.fn();
    const onModelOptionsChange = vi.fn();
    await mount(
      <TraitsPicker
        provider={CLAUDE}
        models={modelsWith([effort])}
        model={MODEL}
        prompt=""
        modelOptions={selections(["effort", "ultrathink"])}
        onPromptChange={onPromptChange}
        onModelOptionsChange={onModelOptionsChange}
      />,
    );

    const trigger = document.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("Ultrathink");
    await click(trigger!);
    await click(radioItem("High"));

    expect(onPromptChange).not.toHaveBeenCalled();
    expect(onModelOptionsChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "effort", value: "high" })]),
    );
  });

  it("removes the generated ultrathink prefix before applying another effort", async () => {
    const onPromptChange = vi.fn();
    const onModelOptionsChange = vi.fn();
    await mount(
      <TraitsPicker
        provider={CLAUDE}
        models={modelsWith([effort])}
        model={MODEL}
        prompt={"Ultrathink:\nImplement this"}
        onPromptChange={onPromptChange}
        onModelOptionsChange={onModelOptionsChange}
      />,
    );

    await click(buttonContaining("Ultrathink"));
    await click(radioItem("Low"));
    expect(onPromptChange).toHaveBeenCalledWith("Implement this");
    expect(onModelOptionsChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "effort", value: "low" })]),
    );
  });

  it("locks effort controls when ultrathink is part of the prompt body", async () => {
    const onPromptChange = vi.fn();
    const onModelOptionsChange = vi.fn();
    await mount(
      <TraitsPicker
        provider={CLAUDE}
        models={modelsWith([effort])}
        model={MODEL}
        prompt="Please ultrathink about this"
        onPromptChange={onPromptChange}
        onModelOptionsChange={onModelOptionsChange}
      />,
    );

    await click(buttonContaining("Ultrathink"));
    expect(document.body.textContent).toContain("Remove it to change this option.");
    expect(radioItem("Low").getAttribute("aria-disabled")).toBe("true");
    await click(radioItem("Low"));
    expect(onPromptChange).not.toHaveBeenCalled();
    expect(onModelOptionsChange).not.toHaveBeenCalled();
  });

  it("disables prompt injection when requested and persists boolean changes to a draft", async () => {
    const onPromptChange = vi.fn();
    const draftId = "draft-traits" as never;
    await mount(
      <TraitsPicker
        provider={CLAUDE}
        instanceId={ProviderInstanceId.make("claude_work")}
        models={modelsWith([effort, booleanDescriptor("thinking", "Thinking")])}
        model={MODEL}
        prompt="Ultrathink: body"
        allowPromptInjectedEffort={false}
        modelOptions={selections(["effort", "high"], ["thinking", false])}
        onPromptChange={onPromptChange}
        draftId={draftId}
      />,
    );

    await click(buttonContaining("High"));
    await click(radioItem("On"));
    expect(onPromptChange).not.toHaveBeenCalled();
    expect(testState.setProviderModelOptions).toHaveBeenCalledWith(
      draftId,
      CLAUDE,
      expect.arrayContaining([expect.objectContaining({ id: "thinking", value: true })]),
      {
        instanceId: ProviderInstanceId.make("claude_work"),
        model: MODEL,
        persistSticky: true,
      },
    );
  });

  it("keeps rendered controls usable when no persistence target is supplied", async () => {
    const mounted = await mount(<NoPersistenceHarness />);

    expect(buttonContaining("High").textContent).toContain("Thinking Off");
    await click(buttonContaining("High"));
    await click(radioItem("Ultrathink"));
    expect(document.querySelector('[data-testid="prompt"]')?.textContent).toBe("Ultrathink:\n");
    expect(buttonContaining("Ultrathink").textContent).toContain("Thinking Off");
    expect(testState.setProviderModelOptions).not.toHaveBeenCalled();

    await act(async () => mounted.root.unmount());
    mountedTrees.splice(mountedTrees.indexOf(mounted), 1);
    mounted.container.remove();
    await mount(
      <TraitsPicker
        provider={CLAUDE}
        models={modelsWith([booleanDescriptor("thinking", "Thinking")])}
        model={MODEL}
        prompt=""
        onPromptChange={vi.fn()}
      />,
    );
    await click(buttonContaining("Thinking Off"));
    await click(radioItem("On"));
    expect(testState.setProviderModelOptions).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toContain("On");
  });
});
