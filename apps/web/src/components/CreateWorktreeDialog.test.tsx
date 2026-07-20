import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t4code/contracts";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type EffectCallback = () => void | (() => void);

const browserRuntime =
  typeof document !== "undefined" && typeof document.createElement === "function";
const staticDescribe = browserRuntime ? describe.skip : describe;

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let stateSlots = new Map<number, unknown>();
  let refSlots = new Map<number, { current: unknown }>();

  return {
    effects: [] as EffectCallback[],
    beginRender() {
      cursor = 0;
      this.effects = [];
    },
    reset() {
      cursor = 0;
      stateSlots = new Map();
      refSlots = new Map();
      this.effects = [];
    },
    runEffects() {
      for (const effect of this.effects) effect();
    },
    useCallback<T>(callback: T): T {
      cursor += 1;
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      cursor += 1;
      return factory();
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = cursor++;
      const existing = refSlots.get(index);
      if (existing) return existing as { current: T };
      const ref = { current: initialValue };
      refSlots.set(index, ref);
      return ref;
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = cursor++;
      if (!stateSlots.has(index)) {
        stateSlots.set(
          index,
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
        );
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = stateSlots.get(index) as T;
        stateSlots.set(
          index,
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue,
        );
      };
      return [stateSlots.get(index) as T, setValue];
    },
    useEffect(effect: EffectCallback) {
      cursor += 1;
      this.effects.push(effect);
    },
  };
});

interface CapturedButtonProps {
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly children?: ReactNode;
  readonly variant?: string;
}

interface CapturedInputProps {
  readonly placeholder?: string;
  readonly value?: string;
  readonly onChange?: (event: { target: { value: string } }) => void;
}

interface CapturedSelectProps {
  readonly value?: string;
  readonly onValueChange?: (value: unknown) => void;
  readonly items?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly children?: ReactNode;
}

interface CapturedDialogProps {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children?: ReactNode;
}

interface CapturedDialogPopupProps {
  readonly onKeyDown?: (event: {
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly key: string;
    readonly preventDefault: () => void;
  }) => void;
  readonly children?: ReactNode;
}

const captured = vi.hoisted(() => ({
  buttons: [] as CapturedButtonProps[],
  inputs: [] as CapturedInputProps[],
  selects: [] as CapturedSelectProps[],
  dialogs: [] as CapturedDialogProps[],
  popups: [] as CapturedDialogPopupProps[],
  collapsibles: [] as Array<{ open?: boolean; onOpenChange?: (open: boolean) => void }>,
  switches: [] as Array<{ checked?: boolean; onCheckedChange?: (checked: boolean) => void }>,
  clear() {
    this.buttons = [];
    this.inputs = [];
    this.selects = [];
    this.dialogs = [];
    this.popups = [];
    this.collapsibles = [];
    this.switches = [];
  },
}));

const testState = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  serverConfigs: new Map<string, Record<string, unknown>>(),
  refs: [] as Array<{ name: string }>,
  queryAtoms: [] as unknown[],
  createWorktree: vi.fn(),
  createThread: vi.fn(),
  navigate: vi.fn(),
  onOpenChange: vi.fn(),
  toastAdd: vi.fn(),
  nextThreadId: "thread-created",
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => testState.navigate }));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { interrupted?: boolean }) => result.interrupted === true,
  squashAtomCommandFailure: (result: { error?: unknown }) => result.error,
}));

vi.mock("~/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  newThreadId: () => testState.nextThreadId,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => testState.projects,
  useServerConfigs: () => testState.serverConfigs,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    testState.queryAtoms.push(atom);
    return { data: atom ? { refs: testState.refs } : null, error: null, isPending: false };
  },
}));

vi.mock("~/state/threads", () => ({ threadEnvironment: { create: "thread.create" } }));

vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    listRefs: (args: unknown) => ({ kind: "vcs.listRefs", args }),
    createWorktree: "vcs.createWorktree",
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "vcs.createWorktree" ? testState.createWorktree : testState.createThread,
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toastAdd },
  stackedThreadToast: (toast: Record<string, unknown>) => ({ ...toast, stacked: true }),
}));

vi.mock("./ui/button", () => ({
  Button: (props: CapturedButtonProps) => {
    captured.buttons.push(props);
    return (
      <button type="button" disabled={props.disabled} onClick={props.onClick}>
        {props.children}
      </button>
    );
  },
}));

vi.mock("./ui/input", () => ({
  Input: (props: CapturedInputProps) => {
    captured.inputs.push(props);
    return (
      <input
        value={props.value}
        placeholder={props.placeholder}
        readOnly={typeof document === "undefined"}
        onChange={props.onChange}
      />
    );
  },
}));

vi.mock("./ui/select", () => ({
  Select: (props: CapturedSelectProps) => {
    captured.selects.push(props);
    return <div>{props.children}</div>;
  },
  SelectGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectGroupLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  SelectItem: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

vi.mock("./ui/dialog", () => ({
  Dialog: (props: CapturedDialogProps) => {
    captured.dialogs.push(props);
    return props.open ? <div>{props.children}</div> : null;
  },
  DialogPopup: (props: CapturedDialogPopupProps) => {
    captured.popups.push(props);
    return (
      <div data-testid="dialog-popup" onKeyDown={props.onKeyDown}>
        {props.children}
      </div>
    );
  },
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./ui/collapsible", () => ({
  Collapsible: (props: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: ReactNode;
  }) => {
    captured.collapsibles.push(props);
    return <div>{props.children}</div>;
  },
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  CollapsiblePanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./ui/switch", () => ({
  Switch: (props: { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => {
    captured.switches.push(props);
    return <input type="checkbox" checked={props.checked} readOnly />;
  },
}));

vi.mock("./ui/kbd", () => ({
  Kbd: ({ children }: { children?: ReactNode }) => <kbd>{children}</kbd>,
}));

if (!browserRuntime) {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      useCallback: hooks.useCallback,
      useMemo: hooks.useMemo,
      useRef: hooks.useRef,
      useState: hooks.useState,
      useEffect: hooks.useEffect.bind(hooks),
    };
  });
  vi.doMock("react/compiler-runtime", () => ({
    c: (size: number) =>
      Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel")),
  }));
}

const { CreateWorktreeDialog } = await import("./CreateWorktreeDialog");

const ENVIRONMENT_ID = EnvironmentId.make("local");
const PROJECT_ID = ProjectId.make("project-one");

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    title: "T4Code",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    ...overrides,
  };
}

function success(value: unknown) {
  return { _tag: "Success", value };
}

function failure(error: unknown, interrupted = false) {
  return { _tag: "Failure", error, interrupted };
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object" && "props" in node) {
    return collectText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function render(open = true, defaultProjectId?: ProjectId | null): string {
  const renderPass = () => {
    hooks.beginRender();
    return renderToStaticMarkup(
      <CreateWorktreeDialog
        open={open}
        onOpenChange={testState.onOpenChange}
        {...(defaultProjectId === undefined ? {} : { defaultProjectId })}
      />,
    );
  };
  renderPass();
  hooks.runEffects();
  captured.clear();
  renderPass();
  hooks.runEffects();
  captured.clear();
  return renderPass();
}

function button(label: string): CapturedButtonProps {
  const match = captured.buttons.find((candidate) =>
    collectText(candidate.children).includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function input(placeholder: string): CapturedInputProps {
  const match = captured.inputs.find((candidate) => candidate.placeholder === placeholder);
  if (!match) throw new Error(`Missing input: ${placeholder}`);
  return match;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function resetScenario(): void {
  hooks.reset();
  captured.clear();
  testState.projects = [project()];
  testState.serverConfigs = new Map();
  testState.refs = [];
  testState.queryAtoms = [];
  testState.createWorktree
    .mockReset()
    .mockResolvedValue(success({ worktree: { path: "/repo/.worktrees/feature" } }));
  testState.createThread.mockReset().mockResolvedValue(success(undefined));
  testState.navigate.mockReset();
  testState.onOpenChange.mockReset();
  testState.toastAdd.mockReset();
  testState.nextThreadId = "thread-created";
}

staticDescribe("CreateWorktreeDialog", () => {
  beforeEach(() => {
    resetScenario();
    vi.stubGlobal("window", {
      requestAnimationFrame: vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a closed dialog inert and skips branch discovery without a project", () => {
    testState.projects = [];
    const markup = render(false);

    expect(markup).toBe("");
    expect(captured.dialogs[0]?.open).toBe(false);
    expect(testState.queryAtoms.at(-1)).toBeNull();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("selects the first project, filters providers, and requests refs for smart mode", () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "claude",
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          installed: true,
          models: [{ id: "sonnet" }],
        },
        { instanceId: "disabled", driver: "codex", enabled: false, installed: true },
        { instanceId: "missing", driver: "codex", enabled: true, installed: false },
      ],
      settings: {
        providers: {},
        providerInstances: {
          claude: { driver: "claudeAgent" },
          missing: { driver: "codex", enabled: true },
        },
      },
    });

    const markup = render();

    expect(captured.selects[0]?.value).toBe(PROJECT_ID);
    expect(captured.selects[1]?.value).toBe("claude");
    expect(captured.selects[1]?.items).toEqual([{ value: "claude", label: "Claude" }]);
    expect(testState.queryAtoms.at(-1)).toEqual({
      kind: "vcs.listRefs",
      args: { environmentId: ENVIRONMENT_ID, input: { cwd: "/repo", query: undefined } },
    });
    expect(markup).toContain("Interpreting as:");
    expect(input("Type a name, #1234, or a branch").value).toBe("");
  });

  it("uses canonical and configured provider names in the Agent selector", () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        { instanceId: "cursor", driver: "cursor", enabled: true, installed: true },
        { instanceId: "opencode", driver: "opencode", enabled: true, installed: true },
        { instanceId: "codex", driver: "codex", enabled: true, installed: true },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
        },
        {
          instanceId: "codex_personal",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
        },
      ],
      settings: {
        providers: {},
        providerInstances: {
          codex_personal: { driver: "codex", displayName: "Personal Codex" },
        },
      },
    });

    const markup = render();

    expect(captured.selects[1]?.items).toEqual([
      { value: "cursor", label: "Cursor" },
      { value: "opencode", label: "OpenCode" },
      { value: "codex", label: "Codex" },
      { value: "claudeAgent", label: "Claude" },
      { value: "codex_personal", label: "Personal Codex" },
    ]);
    expect(markup).not.toContain("claudeAgent");
  });

  it("switches among smart, GitHub, branch, and name inputs and selects branch rows", () => {
    testState.refs = [{ name: "main" }, { name: "feature/login" }];
    render();

    input("Type a name, #1234, or a branch").onChange?.({ target: { value: "feature" } });
    let markup = render();
    expect(markup).toContain("Use &quot;feature&quot;");
    expect(markup).toContain("feature/login");

    button("Branch").onClick?.();
    markup = render();
    expect(input("Search branches").value).toBe("feature");
    expect(markup).toContain("feature/login");
    expect(testState.queryAtoms.at(-1)).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({ input: { cwd: "/repo", query: "feature" } }),
      }),
    );

    button("GitHub").onClick?.();
    render();
    input("#1234 or a GitHub issue/PR URL").onChange?.({ target: { value: "#42" } });
    render();
    expect(button("Create worktree").disabled).toBe(false);

    button("Name").onClick?.();
    render();
    expect(input("Worktree / branch name").value).toBe("#42");
    expect(testState.queryAtoms.at(-1)).toBeNull();
  });

  it("updates project, agent, advanced override, and create-more controls", () => {
    const secondId = ProjectId.make("project-two");
    const secondEnvironmentId = EnvironmentId.make("remote");
    testState.projects.push(
      project({
        id: secondId,
        environmentId: secondEnvironmentId,
        title: "Second",
        workspaceRoot: "/second",
      }),
    );
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        { instanceId: "codex", driver: "codex", enabled: true, installed: true, models: [] },
        {
          instanceId: "claude",
          driver: "claudeAgent",
          displayName: null,
          enabled: true,
          installed: true,
          models: [{ id: "opus" }],
        },
      ],
      settings: {
        providers: {},
        providerInstances: { claude: { driver: "claudeAgent" } },
      },
    });

    render(true, PROJECT_ID);
    captured.selects[0]?.onValueChange?.(secondId);
    render();
    expect(captured.selects[0]?.value).toBe(secondId);

    captured.selects[0]?.onValueChange?.(PROJECT_ID);
    render();
    captured.selects[1]?.onValueChange?.("claude");
    captured.collapsibles[0]?.onOpenChange?.(true);
    captured.switches[0]?.onCheckedChange?.(true);
    let markup = render();
    expect(markup).toContain("Hide advanced");
    input("Defaults to the current branch").onChange?.({ target: { value: "develop" } });
    markup = render();
    expect(input("Defaults to the current branch").value).toBe("develop");
    expect(captured.selects[1]?.value).toBe("claude");
    expect(captured.switches[0]?.checked).toBe(true);
  });

  it("uses the explicit project model selection when the target provider supports it", async () => {
    testState.projects = [
      project({ defaultModelSelection: { instanceId: "opencode", model: "qwen" } }),
    ];
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "opencode",
          driver: "opencode",
          displayName: "OpenCode",
          enabled: true,
          installed: true,
          status: "ready",
          models: [{ slug: "qwen", name: "Qwen", isCustom: false, capabilities: null }],
        },
      ],
      settings: DEFAULT_SERVER_SETTINGS,
    });
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "fallback" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          modelSelection: { instanceId: "opencode", model: "qwen" },
        }),
      }),
    );
  });

  it("resolves the selected provider's shared model, effort, and fast defaults", async () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
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
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerSessionDefaults: {
          codex: {
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "fast" },
            ],
          },
        },
      },
    });

    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "defaults" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "fast" },
            ],
          },
        }),
      }),
    );
  });

  it("falls back to the default Codex selection when project and providers have no model", async () => {
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "fallback" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          modelSelection: expect.objectContaining({ instanceId: "codex" }),
        }),
      }),
    );
  });

  it.each([
    [new Error("git failed"), "git failed"],
    ["opaque", "An error occurred."],
  ])("reports worktree creation failures", async (error, description) => {
    testState.createWorktree.mockResolvedValue(failure(error));
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "failure" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to create worktree", description }),
    );
    expect(testState.createThread).not.toHaveBeenCalled();
  });

  it("suppresses interrupted worktree failures", async () => {
    testState.createWorktree.mockResolvedValue(failure(new Error("cancelled"), true));
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "cancelled" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();
    expect(testState.toastAdd).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("thread failed"), false, "thread failed"],
    ["opaque", false, "An error occurred."],
    [new Error("cancelled"), true, null],
  ])("handles thread creation failures", async (error, interrupted, description) => {
    testState.createThread.mockResolvedValue(failure(error, interrupted));
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "thread-failure" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    if (description === null) {
      expect(testState.toastAdd).not.toHaveBeenCalled();
    } else {
      expect(testState.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Worktree created but thread creation failed",
          description,
        }),
      );
    }
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("resets the form instead of closing when Create more is enabled", async () => {
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "one" } });
    captured.switches[0]?.onCheckedChange?.(true);
    render();
    button("Create worktree").onClick?.();
    await flushPromises();
    const markup = render();

    expect(markup).toContain("Create worktree");
    expect(input("Worktree / branch name").value).toBe("");
    expect(testState.onOpenChange).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("submits with Ctrl+Enter and Meta+Enter but ignores other key combinations", async () => {
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "keyboard" } });
    render();
    const preventDefault = vi.fn();

    captured.popups[0]?.onKeyDown?.({
      ctrlKey: false,
      metaKey: false,
      key: "Enter",
      preventDefault,
    });
    captured.popups[0]?.onKeyDown?.({
      ctrlKey: true,
      metaKey: false,
      key: "Escape",
      preventDefault,
    });
    expect(testState.createWorktree).not.toHaveBeenCalled();

    captured.popups[0]?.onKeyDown?.({
      ctrlKey: true,
      metaKey: false,
      key: "Enter",
      preventDefault,
    });
    await flushPromises();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(testState.createWorktree).toHaveBeenCalledTimes(1);

    testState.createWorktree.mockClear();
    captured.popups[0]?.onKeyDown?.({
      ctrlKey: false,
      metaKey: true,
      key: "Enter",
      preventDefault,
    });
    await flushPromises();
    expect(testState.createWorktree).toHaveBeenCalledTimes(1);
  });

  it("does not submit an invalid keyboard form and reports invalid direct submission", async () => {
    testState.projects = [];
    render();
    const preventDefault = vi.fn();
    captured.popups[0]?.onKeyDown?.({
      ctrlKey: true,
      metaKey: false,
      key: "Enter",
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(testState.createWorktree).not.toHaveBeenCalled();

    button("Create worktree").onClick?.();
    await flushPromises();
    expect(render()).toContain("Choose a project and a name/branch to create the worktree from.");
  });

  it("ignores close requests while a command is pending", async () => {
    let resolveWorktree: ((result: unknown) => void) | undefined;
    testState.createWorktree.mockReturnValue(
      new Promise((resolve) => {
        resolveWorktree = resolve;
      }),
    );
    render();
    button("Name").onClick?.();
    render();
    input("Worktree / branch name").onChange?.({ target: { value: "pending" } });
    render();
    button("Create worktree").onClick?.();
    render();

    expect(button("Creating...").disabled).toBe(true);
    captured.dialogs[0]?.onOpenChange?.(false);
    expect(testState.onOpenChange).not.toHaveBeenCalled();

    resolveWorktree?.(failure(new Error("stopped"), true));
    await flushPromises();
    render();
    captured.dialogs[0]?.onOpenChange?.(false);
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });
});

if (browserRuntime) {
  describe("CreateWorktreeDialog browser interactions", () => {
    beforeEach(() => {
      resetScenario();
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
      const element = container.querySelector<T>(selector);
      if (!element) throw new Error(`Missing DOM element: ${selector}`);
      return element;
    }

    function requiredButton(container: ParentNode, label: string): HTMLButtonElement {
      const match = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.trim().startsWith(label),
      );
      if (!match) {
        throw new Error(`Missing DOM button: ${label}; rendered: ${container.textContent ?? ""}`);
      }
      return match;
    }

    async function dispatch(element: Element, event: Event): Promise<void> {
      await React.act(async () => {
        element.dispatchEvent(event);
      });
    }

    async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("HTMLInputElement.value setter is unavailable");
      setter.call(input, value);
      await dispatch(input, new Event("input", { bubbles: true, cancelable: true }));
    }

    async function mountDialog(): Promise<{
      container: HTMLDivElement;
      root: Root;
    }> {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await React.act(async () => {
        root.render(<CreateWorktreeDialog open onOpenChange={testState.onOpenChange} />);
      });
      return { container, root };
    }

    it("enables and submits the worktree form through real input and Ctrl+Enter events", async () => {
      testState.serverConfigs.set(ENVIRONMENT_ID, {
        providers: [
          {
            instanceId: "claude",
            driver: "claudeAgent",
            displayName: "Claude",
            enabled: true,
            installed: true,
            models: [{ id: "sonnet" }],
          },
        ],
        settings: {
          providers: {},
          providerInstances: { claude: { driver: "claudeAgent" } },
        },
      });
      const { container, root } = await mountDialog();

      expect(requiredButton(container, "Create worktree").disabled).toBe(true);
      await React.act(async () => requiredButton(container, "Name").click());
      const nameInput = requiredElement<HTMLInputElement>(
        container,
        "input[placeholder='Worktree / branch name']",
      );
      await setInputValue(nameInput, "My Feature");
      expect(nameInput.value).toBe("My Feature");
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      const popup = requiredElement<HTMLDivElement>(container, "[data-testid='dialog-popup']");
      await dispatch(
        popup,
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await React.act(async () => flushPromises());

      expect(testState.createWorktree).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        input: {
          cwd: "/repo",
          refName: "HEAD",
          newRefName: "My-Feature",
          baseRefName: "HEAD",
          path: null,
        },
      });
      expect(testState.createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: ENVIRONMENT_ID,
          input: expect.objectContaining({
            threadId: "thread-created",
            modelSelection: expect.objectContaining({ instanceId: "claude", model: "sonnet" }),
          }),
        }),
      );
      expect(testState.onOpenChange).toHaveBeenCalledWith(false);
      expect(testState.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: "thread-created" },
      });

      await React.act(async () => root.unmount());
      container.remove();
    });
  });
}
