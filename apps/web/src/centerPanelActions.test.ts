import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t4code/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  createResult: { _tag: "Success", value: undefined } as unknown,
  deleteResults: [] as unknown[],
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  addToast: vi.fn(),
  openChatPanel: vi.fn(),
  openTerminalPanel: vi.fn(),
  activateSurface: vi.fn(),
  closeSurface: vi.fn(),
  closeOtherSurfaces: vi.fn(),
  closeSurfacesToRight: vi.fn(),
  closeAllSurfaces: vi.fn(),
  surfaces: [] as unknown[],
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
}));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { interrupted?: boolean }) => result.interrupted === true,
  squashAtomCommandFailure: (result: { cause?: unknown }) => result.cause,
}));

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: h.addToast },
}));

vi.mock("~/centerPanelStore", () => ({
  HOST_SURFACE_ID: "host",
  selectThreadCenterPanelState: () => ({ surfaces: h.surfaces }),
  useCenterPanelStore: {
    getState: () => ({
      byThreadKey: {},
      openChatPanel: h.openChatPanel,
      openTerminalPanel: h.openTerminalPanel,
      activateSurface: h.activateSurface,
      closeSurface: h.closeSurface,
      closeOtherSurfaces: h.closeOtherSurfaces,
      closeSurfacesToRight: h.closeSurfacesToRight,
      closeAllSurfaces: h.closeAllSurfaces,
    }),
  },
}));

vi.mock("~/lib/utils", () => ({
  newThreadId: () => "new-panel-thread",
}));

vi.mock("~/state/threads", () => ({
  threadEnvironment: { create: "create", delete: "delete" },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "create" ? h.createThread : h.deleteThread),
}));

import { useCenterPanelActions } from "./centerPanelActions";

const hostRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("host-thread"),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createResult = { _tag: "Success", value: undefined };
  h.deleteResults = [];
  h.surfaces = [];
  h.createThread.mockImplementation(() => Promise.resolve(h.createResult));
  h.deleteThread.mockImplementation(() =>
    Promise.resolve(h.deleteResults.shift() ?? { _tag: "Success", value: undefined }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("center panel actions", () => {
  it("creates chat panels with the resolved selection and copied workspace values", async () => {
    const actions = useCenterPanelActions();
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    const threadId = await actions.createChatPanel({
      hostRef,
      projectId: ProjectId.make("project-1"),
      worktreePath: "",
      branch: "feature/panels",
      modelSelection,
      providerLabel: "Codex",
    });

    expect(threadId).toBe("new-panel-thread");
    expect(h.createThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: expect.objectContaining({
        threadId: "new-panel-thread",
        title: "Panel — Codex",
        branch: "feature/panels",
        worktreePath: null,
        modelSelection,
        kind: "panel",
      }),
    });
    expect(h.createThread.mock.calls[0]?.[0].input.modelSelection).toBe(modelSelection);
    expect(h.openChatPanel).toHaveBeenCalledWith(hostRef, threadId, "Codex");

    await actions.createChatPanel({
      hostRef,
      projectId: ProjectId.make("project-1"),
      worktreePath: "/tmp/worktree",
      branch: null,
      modelSelection,
      providerLabel: "Codex",
    });
    expect(h.createThread).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ branch: null, worktreePath: "/tmp/worktree" }),
      }),
    );
  });

  it("returns null for interrupted creation and reports typed and untyped failures", async () => {
    const actions = useCenterPanelActions();
    const input = {
      hostRef,
      projectId: ProjectId.make("project-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-instance"),
        model: "gpt-5.4",
      },
      providerLabel: "Codex",
    };

    h.createResult = { _tag: "Failure", interrupted: true, cause: new Error("cancelled") };
    await expect(actions.createChatPanel(input)).resolves.toBeNull();
    expect(h.addToast).not.toHaveBeenCalled();

    h.createResult = { _tag: "Failure", cause: new Error("server offline") };
    await expect(actions.createChatPanel(input)).resolves.toBeNull();
    expect(h.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "server offline" }),
    );

    h.createResult = { _tag: "Failure", cause: "unknown" };
    await expect(actions.createChatPanel(input)).resolves.toBeNull();
    expect(h.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "An error occurred." }),
    );
  });

  it("opens, activates, and closes individual surfaces", async () => {
    const actions = useCenterPanelActions();
    const options = {
      label: "Codex Terminal",
      command: {
        executable: "/opt/codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        label: "Codex Terminal",
      },
    };
    expect(actions.openTerminalPanel(hostRef, ["term-1", "term-3"], options)).toBe("term-2");
    expect(h.openTerminalPanel).toHaveBeenCalledWith(hostRef, "term-2", options);

    actions.activateSurface(hostRef, "terminal:term-2");
    expect(h.activateSurface).toHaveBeenCalledWith(hostRef, "terminal:term-2");

    actions.closeSurface(hostRef, { id: "terminal:term-2", kind: "terminal" } as never);
    expect(h.deleteThread).not.toHaveBeenCalled();

    actions.closeSurface(hostRef, {
      id: "chat:panel-1",
      kind: "chat",
      threadId: ThreadId.make("panel-1"),
    } as never);
    await Promise.resolve();
    expect(h.closeSurface).toHaveBeenCalledTimes(2);
    expect(h.deleteThread).toHaveBeenCalledOnce();
  });

  it("deletes dropped chat threads for other, right, and all close operations", async () => {
    const chatOne = {
      id: "chat:panel-1",
      kind: "chat",
      threadId: ThreadId.make("panel-1"),
    };
    const terminal = { id: "terminal:term-1", kind: "terminal" };
    const chatTwo = {
      id: "chat:panel-2",
      kind: "chat",
      threadId: ThreadId.make("panel-2"),
    };
    h.surfaces = [{ id: "host", kind: "host" }, chatOne, terminal, chatTwo];
    const actions = useCenterPanelActions();

    actions.closeOtherSurfaces(hostRef, chatOne as never);
    await Promise.resolve();
    expect(h.deleteThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: "panel-2" },
    });

    h.deleteThread.mockClear();
    actions.closeSurfacesToRight(hostRef, terminal as never);
    await Promise.resolve();
    expect(h.deleteThread).toHaveBeenCalledOnce();

    h.deleteThread.mockClear();
    actions.closeSurfacesToRight(hostRef, { id: "missing", kind: "terminal" } as never);
    expect(h.deleteThread).not.toHaveBeenCalled();

    actions.closeAllSurfaces(hostRef);
    await Promise.resolve();
    expect(h.deleteThread).toHaveBeenCalledTimes(2);
  });

  it("reports non-interrupted panel deletion failures", async () => {
    h.deleteResults = [
      { _tag: "Failure", interrupted: true, cause: new Error("cancelled") },
      { _tag: "Failure", cause: new Error("delete failed") },
      { _tag: "Failure", cause: "unknown" },
    ];
    const actions = useCenterPanelActions();
    const surface = {
      id: "chat:panel-1",
      kind: "chat",
      threadId: ThreadId.make("panel-1"),
    } as never;

    actions.closeSurface(hostRef, surface);
    actions.closeSurface(hostRef, surface);
    actions.closeSurface(hostRef, surface);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.addToast).toHaveBeenCalledTimes(2);
    expect(h.addToast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ description: "delete failed" }),
    );
    expect(h.addToast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ description: "An error occurred." }),
    );
  });
});
