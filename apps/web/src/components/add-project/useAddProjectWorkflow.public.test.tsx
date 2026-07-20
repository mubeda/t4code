// @vitest-environment happy-dom

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t4code/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  environments: [] as unknown[],
  createProject: vi.fn(),
  cloneRepository: vi.fn(),
  handleNewThread: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock("~/connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => [],
}));

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: harness.handleNewThread }),
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: harness.environments,
  }),
  usePrimaryEnvironment: () => harness.environments[0] ?? null,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => [],
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    create: { key: "project.create" },
  },
}));

vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    clone: { key: "vcs.clone" },
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly key?: string }) => {
    if (command.key === "project.create") {
      return (input: unknown) => harness.createProject(input);
    }
    if (command.key === "vcs.clone") {
      return (input: unknown) => harness.cloneRepository(input);
    }
    throw new Error(`Unexpected atom command: ${String(command.key)}`);
  },
}));

import { useAddProjectWorkflow, type AddProjectWorkflow } from "./useAddProjectWorkflow";

const environmentId = EnvironmentId.make("public-workflow");
const codexInstanceId = ProviderInstanceId.make("codex");
const expectedSelection: ModelSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.4",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "fast" },
  ],
};

const provider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-20T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
            currentValue: "medium",
          },
          {
            id: "serviceTier",
            label: "Service tier",
            type: "select",
            options: [
              { id: "default", label: "Default", isDefault: true },
              { id: "fast", label: "Fast" },
            ],
            currentValue: "default",
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
  agents: [],
};

let currentWorkflow: AddProjectWorkflow;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function WorkflowProbe() {
  currentWorkflow = useAddProjectWorkflow({
    open: true,
    onOpenChange: harness.onOpenChange,
  });
  return null;
}

async function mountWorkflow(): Promise<AddProjectWorkflow> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<WorkflowProbe />));
  return currentWorkflow;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.environments = [
    {
      environmentId,
      label: "Local",
      displayUrl: "http://localhost:4317",
      relayManaged: false,
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          environmentId,
          label: "Local",
          httpBaseUrl: "http://localhost:4317",
          wsBaseUrl: "ws://localhost:4317",
        },
      },
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: {
        environment: {
          environmentId,
          label: "Local",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.2.3",
          capabilities: { repositoryIdentity: true },
        },
        providers: [provider],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          addProjectBaseDirectory: "/code/",
          providerSessionDefaults: {
            codex: {
              model: expectedSelection.model,
              options: expectedSelection.options,
            },
          },
        },
      },
    },
  ];
  harness.createProject.mockReset().mockImplementation(async (command) => {
    const input = command as { readonly input: { readonly projectId: string } };
    return AsyncResult.success({ projectId: input.input.projectId });
  });
  harness.cloneRepository
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ path: "/code/cloned" }));
  harness.handleNewThread.mockReset().mockResolvedValue(undefined);
  harness.onOpenChange.mockReset();
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useAddProjectWorkflow public adapter", () => {
  it.each(["add", "clone", "create"] as const)(
    "inherits the resolved Codex model and options for the %s flow",
    async (flow) => {
      const workflow = await mountWorkflow();

      if (flow === "add") {
        act(() => currentWorkflow.setHostPath("/code/added"));
        await act(async () => currentWorkflow.submitHostPath());
      } else if (flow === "clone") {
        act(() => currentWorkflow.openClone());
        act(() => currentWorkflow.setCloneUrl("https://example.test/repository.git"));
        act(() => currentWorkflow.setCloneParent("/code"));
        await act(async () => currentWorkflow.submitClone());
      } else {
        act(() => currentWorkflow.openCreate());
        act(() => currentWorkflow.setCreateName("created"));
        act(() => currentWorkflow.setCreateParent("/code"));
        await act(async () => currentWorkflow.submitCreate());
      }

      expect(workflow.selectedHost.environmentId).toBe(environmentId);
      expect(harness.createProject).toHaveBeenCalledTimes(1);
      expect(harness.createProject.mock.calls[0]?.[0]).toMatchObject({
        environmentId,
        input: {
          defaultModelSelection: expectedSelection,
        },
      });
      expect(harness.handleNewThread).toHaveBeenCalledTimes(1);
      expect(harness.onOpenChange).toHaveBeenCalledWith(false);
    },
  );
});
