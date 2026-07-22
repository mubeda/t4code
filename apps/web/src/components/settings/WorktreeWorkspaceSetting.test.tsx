// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t4code/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t4code/contracts/settings";
import type { EnvironmentPresentation } from "../../state/environments";

type Props = Record<string, unknown>;

const harness = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  primaryEnvironment: null as EnvironmentPresentation | null,
  settingsByEnvironment: new Map<string, UnifiedSettings>(),
  updateByEnvironment: new Map<string, ReturnType<typeof vi.fn>>(),
  rows: [] as Props[],
  selects: [] as Props[],
  draftInputs: [] as Props[],
  buttons: [] as Props[],
  pickers: [] as Props[],
  reset() {
    this.environments = [];
    this.primaryEnvironment = null;
    this.settingsByEnvironment.clear();
    this.updateByEnvironment.clear();
    this.rows.length = 0;
    this.selects.length = 0;
    this.draftInputs.length = 0;
    this.buttons.length = 0;
    this.pickers.length = 0;
  },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: harness.environments }),
  usePrimaryEnvironment: () => harness.primaryEnvironment,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: string) =>
    harness.settingsByEnvironment.get(environmentId) ?? DEFAULT_UNIFIED_SETTINGS,
  useUpdateEnvironmentSettings: (environmentId: string) => {
    let update = harness.updateByEnvironment.get(environmentId);
    if (!update) {
      update = vi.fn(async (patch: Partial<UnifiedSettings>) => ({
        _tag: "Success",
        value: { ...DEFAULT_UNIFIED_SETTINGS, ...patch },
      }));
      harness.updateByEnvironment.set(environmentId, update);
    }
    return update;
  },
}));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { readonly _tag?: string }) => result._tag === "Interrupted",
  squashAtomCommandFailure: (result: { readonly error?: unknown }) => result.error,
}));

vi.mock("./settingsLayout", () => ({
  SettingsRow: (props: Props) => {
    harness.rows.push(props);
    return (
      <section>
        {props.title as ReactNode}
        {props.description as ReactNode}
        {props.status as ReactNode}
        {props.resetAction as ReactNode}
        {props.control as ReactNode}
      </section>
    );
  },
  SettingResetButton: (props: Props) => {
    harness.buttons.push({ ...props, children: "Reset" });
    return <button aria-label={`Reset ${String(props.label)} to default`} />;
  },
}));

vi.mock("../ui/button", () => ({
  Button: (props: Props) => {
    harness.buttons.push(props);
    return <button disabled={Boolean(props.disabled)}>{props.children as ReactNode}</button>;
  },
}));

vi.mock("../ui/draft-input", () => ({
  DraftInput: (props: Props) => {
    harness.draftInputs.push(props);
    return <input aria-label={String(props["aria-label"])} value={String(props.value)} readOnly />;
  },
}));

vi.mock("../ui/select", () => ({
  Select: (props: Props) => {
    harness.selects.push(props);
    return <div>{props.children as ReactNode}</div>;
  },
  SelectTrigger: (props: Props) => (
    <button aria-label={String(props["aria-label"])}>{props.children as ReactNode}</button>
  ),
  SelectValue: (props: Props) => <>{props.children as ReactNode}</>,
  SelectPopup: (props: Props) => <>{props.children as ReactNode}</>,
  SelectItem: (props: Props) => <>{props.children as ReactNode}</>,
}));

vi.mock("./RemoteDirectoryPickerDialog", () => ({
  RemoteDirectoryPickerDialog: (props: Props) => {
    harness.pickers.push(props);
    return props.open ? <div data-testid="remote-directory-picker" /> : null;
  },
}));

const { WorktreeWorkspaceSetting } = await import("./WorktreeWorkspaceSetting");

function connectedEnvironment(id: string, label: string): EnvironmentPresentation {
  return {
    environmentId: EnvironmentId.make(id),
    label,
    displayUrl: null,
    relayManaged: false,
    entry: {} as EnvironmentPresentation["entry"],
    serverConfig: null,
    connection: { phase: "connected", error: null, traceId: null },
  };
}

function disconnectedEnvironment(id: string, label: string): EnvironmentPresentation {
  return {
    ...connectedEnvironment(id, label),
    connection: { phase: "offline", error: null, traceId: null },
  };
}

interface MountedSetting {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mounted: MountedSetting[] = [];

async function renderSetting(): Promise<MountedSetting> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const setting = { container, root };
  mounted.push(setting);
  await act(async () => root.render(<WorktreeWorkspaceSetting />));
  return setting;
}

async function rerender(setting: MountedSetting): Promise<void> {
  await act(async () => setting.root.render(<WorktreeWorkspaceSetting />));
}

function latest<T>(items: T[]): T {
  const item = items.at(-1);
  if (!item) throw new Error("Expected captured props");
  return item;
}

function select(label: string): Props {
  const hasAccessibleLabel = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(hasAccessibleLabel);
    if (node !== null && typeof node === "object" && "props" in node) {
      const props = (node as { props: Props }).props;
      return props["aria-label"] === label || hasAccessibleLabel(props.children);
    }
    return false;
  };
  const item = harness.selects.findLast((candidate) => hasAccessibleLabel(candidate.children));
  if (!item) throw new Error(`No select labelled ${label}`);
  return item;
}

async function invoke(props: Props, callback: string, ...args: unknown[]): Promise<void> {
  const handler = props[callback];
  if (typeof handler !== "function") throw new Error(`Missing ${callback}`);
  await act(async () => {
    await handler(...args);
  });
}

async function commitDraft(label: string, value: string): Promise<void> {
  const input = latest(
    harness.draftInputs.filter((candidate) => candidate["aria-label"] === label),
  );
  await invoke(input, "onCommit", value);
}

function button(label: string): Props {
  const item = harness.buttons.find((candidate) => candidate.children === label);
  if (!item) throw new Error(`No button labelled ${label}`);
  return item;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.reset();
});

afterEach(async () => {
  for (const setting of mounted.splice(0)) {
    await act(async () => setting.root.unmount());
    setting.container.remove();
  }
});

describe("WorktreeWorkspaceSetting", () => {
  it("shows the default copy and routes manual commits to the only host", async () => {
    harness.environments = [connectedEnvironment("host-one", "Local")];
    harness.settingsByEnvironment.set("host-one", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "",
    });
    const setting = await renderSetting();

    expect(setting.container.textContent).toContain("Workspace");
    expect(setting.container.textContent).toContain(
      "Default: worktrees are stored next to each project.",
    );
    expect(harness.selects).toHaveLength(0);
    await commitDraft("Workspace directory", "D:\\Worktrees");
    expect(harness.updateByEnvironment.get("host-one")).toHaveBeenCalledWith({
      worktreeBaseDirectory: "D:\\Worktrees",
    });
  });

  it("initializes and routes Workspace to the non-first primary host", async () => {
    const local = connectedEnvironment("host-one", "Local");
    const buildServer = connectedEnvironment("host-two", "Build server");
    harness.environments = [local, buildServer];
    harness.primaryEnvironment = buildServer;
    harness.settingsByEnvironment.set("host-two", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "/srv/worktrees",
    });

    await renderSetting();

    expect(select("Workspace host").value).toBe("host-two");
    expect(latest(harness.draftInputs).value).toBe("/srv/worktrees");
    await commitDraft("Workspace directory", "/srv/next-worktrees");
    expect(harness.updateByEnvironment.get("host-two")).toHaveBeenCalledWith({
      worktreeBaseDirectory: "/srv/next-worktrees",
    });
    expect(harness.updateByEnvironment.get("host-one")).toBeUndefined();
  });

  it("shows Host for multiple connected servers and remounts the selected editor", async () => {
    harness.environments = [
      connectedEnvironment("host-one", "Local"),
      connectedEnvironment("host-two", "Build server"),
    ];
    const setting = await renderSetting();

    expect(select("Workspace host").value).toBe("host-one");
    await invoke(select("Workspace host"), "onValueChange", "host-two");
    await rerender(setting);
    expect(select("Workspace host").value).toBe("host-two");
  });

  it("opens the picker and routes its selection to the selected host", async () => {
    harness.environments = [connectedEnvironment("host-one", "Local")];
    await renderSetting();

    await invoke(button("Browse"), "onClick");
    expect(latest(harness.pickers).environmentId).toBe("host-one");
    expect(latest(harness.pickers).open).toBe(true);
    await invoke(latest(harness.pickers), "onSelect", "/srv/worktrees");
    expect(harness.updateByEnvironment.get("host-one")).toHaveBeenCalledWith({
      worktreeBaseDirectory: "/srv/worktrees",
    });
  });

  it("shows the canonical Workspace returned by the server before the settings stream catches up", async () => {
    harness.environments = [connectedEnvironment("host-one", "Local")];
    harness.settingsByEnvironment.set("host-one", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "",
    });
    let resolveUpdate:
      | ((result: { readonly _tag: "Success"; readonly value: UnifiedSettings }) => void)
      | undefined;
    harness.updateByEnvironment.set(
      "host-one",
      vi.fn(
        () =>
          new Promise<{ readonly _tag: "Success"; readonly value: UnifiedSettings }>((resolve) => {
            resolveUpdate = resolve;
          }),
      ),
    );
    const setting = await renderSetting();

    harness.settingsByEnvironment.set("host-one", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "",
    });
    await rerender(setting);

    await invoke(button("Browse"), "onClick");
    await invoke(latest(harness.pickers), "onSelect", "C:\\Users\\mauro\\WORKTR~1");

    harness.settingsByEnvironment.set("host-one", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "",
    });
    await rerender(setting);
    await act(async () => {
      resolveUpdate?.({
        _tag: "Success",
        value: {
          ...DEFAULT_UNIFIED_SETTINGS,
          worktreeBaseDirectory: "C:\\Users\\mauro\\Worktrees",
        },
      });
      await Promise.resolve();
    });

    expect(latest(harness.draftInputs).value).toBe("C:\\Users\\mauro\\Worktrees");

    harness.settingsByEnvironment.set("host-one", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "",
    });
    await rerender(setting);

    expect(latest(harness.draftInputs).value).toBe("");
  });

  it("resets a configured workspace", async () => {
    harness.environments = [connectedEnvironment("host-one", "Local")];
    harness.settingsByEnvironment.set("host-one", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "/srv/worktrees",
    });
    await renderSetting();

    await invoke(button("Reset"), "onClick", { stopPropagation: vi.fn() });
    expect(harness.updateByEnvironment.get("host-one")).toHaveBeenCalledWith({
      worktreeBaseDirectory: "",
    });
  });

  it("shows a typed failure while retaining the server-owned configured directory", async () => {
    harness.environments = [connectedEnvironment("host-one", "Local")];
    harness.settingsByEnvironment.set("host-one", {
      ...DEFAULT_UNIFIED_SETTINGS,
      worktreeBaseDirectory: "/srv/old",
    });
    harness.updateByEnvironment.set(
      "host-one",
      vi.fn(async () => ({ _tag: "Failure", error: new Error("Permission denied") })),
    );
    const setting = await renderSetting();

    await commitDraft("Workspace directory", "/srv/new");
    expect(setting.container.textContent).toContain("Permission denied");
    expect(latest(harness.draftInputs).value).toBe("/srv/old");
  });

  it("disables Workspace editing and Browse for a disconnected selected host", async () => {
    harness.environments = [disconnectedEnvironment("host-one", "Offline host")];
    const setting = await renderSetting();

    expect(setting.container.textContent).toContain("Reconnect Offline host to change Workspace.");
    expect(latest(harness.draftInputs).disabled).toBe(true);
    expect(button("Browse").disabled).toBe(true);
  });

  it("closes the previous picker lifecycle when the host changes", async () => {
    harness.environments = [
      connectedEnvironment("host-one", "Local"),
      connectedEnvironment("host-two", "Build server"),
    ];
    const setting = await renderSetting();
    await invoke(button("Browse"), "onClick");
    const priorPicker = latest(harness.pickers);

    await invoke(select("Workspace host"), "onValueChange", "host-two");
    await rerender(setting);
    expect(latest(harness.pickers).environmentId).toBe("host-two");
    expect(latest(harness.pickers).open).toBe(false);

    await invoke(priorPicker, "onSelect", "/stale/worktrees");
    expect(harness.updateByEnvironment.get("host-two")).not.toHaveBeenCalled();
  });
});
