import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Duration from "effect/Duration";
import {
  type DesktopUpdateState,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t4code/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t4code/contracts/settings";

type AnyProps = Record<string, unknown>;

interface CapturedControl {
  readonly kind: string;
  readonly label: string;
  readonly props: AnyProps;
}

const h = vi.hoisted(() => {
  const textOf = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node !== null && typeof node === "object" && "props" in node) {
      const props = (node as { props: { children?: unknown } }).props;
      return textOf(props.children);
    }
    return "";
  };

  return {
    textOf,
    controls: [] as Array<{ kind: string; label: string; props: Record<string, unknown> }>,
    rows: [] as Array<Record<string, unknown>>,
    modelPickers: [] as Array<Record<string, unknown>>,
    traitsPickers: [] as Array<Record<string, unknown>>,
    instanceCards: [] as Array<Record<string, unknown>>,
    theme: "system" as string,
    setTheme: vi.fn(),
    settings: null as unknown,
    updateSettings: vi.fn(),
    observability: null as unknown,
    serverProviders: [] as unknown[],
    updateState: null as unknown,
    primaryEnvironment: null as unknown,
    projects: [] as unknown[],
    unarchiveThread: vi.fn(),
    confirmAndDeleteThread: vi.fn(),
    archive: {
      snapshots: [] as unknown[],
      error: null as string | null,
      isLoading: false,
      refresh: vi.fn(),
    },
    localApi: undefined as unknown,
    refreshProvidersCommand: vi.fn(),
    updateProviderCommand: vi.fn(),
    genericCommand: vi.fn(),
    toastAdd: vi.fn(),
    atoms: {
      observability: Symbol("primaryServerObservabilityAtom"),
      providers: Symbol("primaryServerProvidersAtom"),
      refreshProviders: Symbol("serverEnvironment.refreshProviders"),
      updateProvider: Symbol("serverEnvironment.updateProvider"),
    },
  };
});

// Execute functional state updaters synchronously so handler bodies that set
// "started"/toggle flags inside setState callbacks are exercised. React's
// server renderer otherwise ignores dispatches issued after render.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (initial: unknown) => {
    const [value] = (actual.useState as (input: unknown) => [unknown, (next: unknown) => void])(
      initial,
    );
    const setState = (next: unknown) => {
      if (typeof next === "function") {
        (next as (previous: unknown) => unknown)(value);
      }
    };
    return [value, setState];
  };
  return { ...actual, useState };
});

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({ theme: h.theme, setTheme: h.setTheme, resolvedTheme: "light" }),
}));

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => h.settings,
  useUpdatePrimarySettings: () => h.updateSettings,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    if (atom === h.atoms.observability) return h.observability;
    if (atom === h.atoms.providers) return h.serverProviders;
    throw new Error("Unexpected atom read in test");
  },
}));

vi.mock("../../state/server", () => ({
  primaryServerObservabilityAtom: h.atoms.observability,
  primaryServerProvidersAtom: h.atoms.providers,
  serverEnvironment: {
    refreshProviders: h.atoms.refreshProviders,
    updateProvider: h.atoms.updateProvider,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) => {
    if (atom === h.atoms.refreshProviders) return h.refreshProvidersCommand;
    if (atom === h.atoms.updateProvider) return h.updateProviderCommand;
    return h.genericCommand;
  },
}));

vi.mock("../../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => h.updateState,
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => h.primaryEnvironment,
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => h.projects,
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    unarchiveThread: h.unarchiveThread,
    confirmAndDeleteThread: h.confirmAndDeleteThread,
  }),
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => h.archive,
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => h.localApi,
  ensureLocalApi: () => {
    if (h.localApi === undefined) {
      throw new Error("Local API not found");
    }
    return h.localApi;
  },
}));

vi.mock("../../branding", () => ({
  APP_VERSION: "9.9.9-test",
  HOSTED_APP_CHANNEL: "latest",
  HOSTED_APP_CHANNEL_LABEL: "Latest",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (props: AnyProps) => (
    <a data-testid="router-link" data-to={String(props.to)}>
      {props.children as ReactNode}
    </a>
  ),
}));

vi.mock("@t4code/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: unknown, threadId: unknown) => ({ environmentId, threadId }),
}));

vi.mock("@t4code/client-runtime/errors", () => ({
  safeErrorLogAttributes: (error: unknown) => ({ error: String(error) }),
}));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: unknown) =>
    (result as { interrupted?: boolean }).interrupted === true,
  squashAtomCommandFailure: (result: unknown) =>
    (result as { cause?: unknown }).cause ?? new Error("Command failed."),
  settlePromise: async (run: () => Promise<unknown>) => {
    try {
      return { _tag: "Success", value: await run() };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  },
}));

vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: AnyProps) => {
    h.modelPickers.push(props);
    return <div data-testid="provider-model-picker" />;
  },
}));

vi.mock("../chat/TraitsPicker", () => ({
  TraitsPicker: (props: AnyProps) => {
    h.traitsPickers.push(props);
    return <div data-testid="traits-picker" />;
  },
}));

vi.mock("./AddProviderInstanceDialog", () => ({
  AddProviderInstanceDialog: (props: AnyProps) => (
    <div data-testid="add-provider-instance-dialog" data-open={String(props.open)} />
  ),
}));

vi.mock("./ProviderInstanceCard", () => ({
  ProviderInstanceCard: (props: AnyProps) => {
    h.instanceCards.push(props);
    return (
      <div data-testid="provider-instance-card" data-instance-id={String(props.instanceId)}>
        {props.headerAction as ReactNode}
      </div>
    );
  },
}));

vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: () => <span data-testid="project-favicon" />,
}));

vi.mock("./settingsLayout", () => ({
  useRelativeTimeTick: () => Date.now(),
  SettingsPageContainer: (props: AnyProps) => (
    <div data-testid="settings-page">{props.children as ReactNode}</div>
  ),
  SettingsSection: (props: AnyProps) => (
    <section data-section-title={typeof props.title === "string" ? props.title : "custom"}>
      {props.icon as ReactNode}
      {props.title as ReactNode}
      {props.headerAction as ReactNode}
      {props.children as ReactNode}
    </section>
  ),
  SettingsRow: (props: AnyProps) => {
    h.rows.push(props);
    return (
      <div data-testid="settings-row">
        {props.title as ReactNode}
        {props.resetAction as ReactNode}
        {props.description as ReactNode}
        {props.status as ReactNode}
        {props.control as ReactNode}
        {props.children as ReactNode}
      </div>
    );
  },
  SettingResetButton: (props: AnyProps) => {
    h.controls.push({
      kind: "button",
      label: `Reset ${String(props.label)} to default`,
      props,
    });
    return <button type="button" data-reset-label={String(props.label)} />;
  },
}));

vi.mock("../ui/button", () => ({
  Button: (props: AnyProps) => {
    h.controls.push({
      kind: "button",
      label: (props["aria-label"] as string | undefined) ?? h.textOf(props.children),
      props,
    });
    return (
      <button type="button" data-variant={String(props.variant)} disabled={Boolean(props.disabled)}>
        {props.children as ReactNode}
      </button>
    );
  },
}));

vi.mock("../ui/select", () => ({
  Select: (props: AnyProps) => {
    h.controls.push({ kind: "select", label: String(props.value), props });
    return (
      <div data-testid="select" data-value={String(props.value)}>
        {props.children as ReactNode}
      </div>
    );
  },
  SelectTrigger: (props: AnyProps) => (
    <div data-select-trigger aria-label={props["aria-label"] as string | undefined}>
      {props.children as ReactNode}
    </div>
  ),
  SelectValue: (props: AnyProps) => <span>{props.children as ReactNode}</span>,
  SelectPopup: (props: AnyProps) => <div data-select-popup>{props.children as ReactNode}</div>,
  SelectItem: (props: AnyProps) => (
    <div data-select-item data-value={String(props.value)}>
      {props.children as ReactNode}
    </div>
  ),
}));

vi.mock("../ui/switch", () => ({
  Switch: (props: AnyProps) => {
    h.controls.push({
      kind: "switch",
      label: (props["aria-label"] as string | undefined) ?? "",
      props,
    });
    return (
      <span
        data-testid="switch"
        aria-label={props["aria-label"] as string | undefined}
        data-checked={String(props.checked)}
        data-disabled={String(Boolean(props.disabled))}
      />
    );
  },
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: h.toastAdd },
  stackedThreadToast: (options: unknown) => options,
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: AnyProps) => <>{props.children as ReactNode}</>,
  TooltipTrigger: (props: AnyProps) => (
    <span data-tooltip-trigger>
      {props.render as ReactNode}
      {props.children as ReactNode}
    </span>
  ),
  TooltipPopup: (props: AnyProps) => <div data-tooltip-popup>{props.children as ReactNode}</div>,
}));

vi.mock("../ui/draft-input", () => ({
  DraftInput: (props: AnyProps) => {
    h.controls.push({
      kind: "draft-input",
      label: (props["aria-label"] as string | undefined) ?? "",
      props,
    });
    return (
      <input
        aria-label={props["aria-label"] as string | undefined}
        defaultValue={props.value as string | undefined}
        readOnly
      />
    );
  },
}));

import {
  ArchivedThreadsPanel,
  GeneralSettingsPanel,
  ProviderSettingsPanel,
  useSettingsRestore,
} from "./SettingsPanels";

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const ENVIRONMENT_ID = EnvironmentId.make("environment-test");

function clearRegistries(): void {
  h.controls.length = 0;
  h.rows.length = 0;
  h.modelPickers.length = 0;
  h.traitsPickers.length = 0;
  h.instanceCards.length = 0;
}

function render(node: ReactElement): string {
  clearRegistries();
  return renderToStaticMarkup(node);
}

function findControls(kind: string, label: string): CapturedControl[] {
  const exact = h.controls.filter((entry) => entry.kind === kind && entry.label === label);
  if (exact.length > 0) {
    return exact;
  }
  return h.controls.filter((entry) => entry.kind === kind && entry.label.includes(label));
}

function control(kind: string, label: string): CapturedControl {
  const found = findControls(kind, label);
  if (found.length === 0) {
    throw new Error(`No ${kind} control labelled ${label}`);
  }
  return found[0]!;
}

function invoke(entry: CapturedControl, handlerName: string, ...args: unknown[]): unknown {
  const handler = entry.props[handlerName];
  if (typeof handler !== "function") {
    throw new Error(`Control ${entry.label} has no handler ${handlerName}`);
  }
  return (handler as (...input: unknown[]) => unknown)(...args);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeUpdateState(overrides: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "9.9.9-test",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

function makeServerProvider(overrides: {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly behindLatest?: boolean;
  readonly canUpdate?: boolean;
  readonly updateRunning?: boolean;
  readonly checkedAt?: string;
}): ServerProvider {
  const behindLatest = overrides.behindLatest ?? false;
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(overrides.instanceId),
    driver: overrides.driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: overrides.checkedAt ?? "2026-06-26T12:00:00.000Z",
    models: [
      { slug: "model-alpha", name: "Model Alpha" },
      { slug: "model-beta", name: "Model Beta" },
    ],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: behindLatest ? "behind_latest" : "current",
      currentVersion: "1.0.0",
      latestVersion: behindLatest ? "1.1.0" : "1.0.0",
      updateCommand: "npm install -g provider@latest",
      canUpdate: overrides.canUpdate ?? true,
      checkedAt: "2026-06-26T12:00:00.000Z",
      message: behindLatest ? "Update available." : "Up to date.",
    },
  } as unknown as ServerProvider;

  if (overrides.updateRunning) {
    return {
      ...provider,
      updateState: {
        status: "running",
        startedAt: "2026-06-26T12:00:00.000Z",
        finishedAt: null,
        message: null,
        output: null,
      },
    } as unknown as ServerProvider;
  }
  return provider;
}

function changedSettings(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    timestampFormat: "24-hour",
    sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount + 3,
    wordWrap: !DEFAULT_UNIFIED_SETTINGS.wordWrap,
    diffIgnoreWhitespace: !DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
    autoOpenPlanSidebar: !DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
    enableAssistantStreaming: !DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
    enableProviderUpdateChecks: !DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
    automaticGitFetchInterval: Duration.sum(
      DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      Duration.minutes(5),
    ),
    defaultThreadEnvMode: "worktree",
    newWorktreesStartFromOrigin: !DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
    addProjectBaseDirectory: "~/code",
    confirmThreadArchive: !DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
    confirmThreadDelete: !DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
    textGenerationModelSelection: { instanceId: CODEX_INSTANCE_ID, model: "model-beta" },
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearRegistries();
  h.theme = "system";
  h.setTheme.mockReset();
  h.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  h.updateSettings.mockReset();
  h.observability = null;
  h.serverProviders = [];
  h.updateState = null;
  h.primaryEnvironment = { environmentId: ENVIRONMENT_ID };
  h.projects = [];
  h.unarchiveThread.mockReset();
  h.unarchiveThread.mockResolvedValue({ _tag: "Success", value: undefined });
  h.confirmAndDeleteThread.mockReset();
  h.confirmAndDeleteThread.mockResolvedValue({ _tag: "Success", value: undefined });
  h.archive.snapshots = [];
  h.archive.error = null;
  h.archive.isLoading = false;
  h.archive.refresh.mockReset();
  h.localApi = undefined;
  h.refreshProvidersCommand.mockReset();
  h.refreshProvidersCommand.mockResolvedValue({ _tag: "Success", value: { providers: [] } });
  h.updateProviderCommand.mockReset();
  h.updateProviderCommand.mockResolvedValue({ _tag: "Success", value: { providers: [] } });
  h.genericCommand.mockReset();
  h.toastAdd.mockReset();
});

describe("GeneralSettingsPanel", () => {
  it("renders default settings with no reset affordances and routes updates", () => {
    const assignSpy = vi.fn();
    vi.stubGlobal("window", {
      desktopBridge: undefined,
      confirm: vi.fn(() => true),
      location: { assign: assignSpy },
    });

    const markup = render(<GeneralSettingsPanel />);

    expect(markup).toContain("Theme");
    expect(markup).toContain("Time format");
    expect(markup).toContain("Terminal logs only.");
    expect(markup).toContain("9.9.9-test");
    expect(findControls("button", "Reset ")).toHaveLength(0);
    expect(findControls("switch", "Start new worktrees from origin by default")).toHaveLength(0);

    invoke(control("select", "system"), "onValueChange", "dark");
    expect(h.setTheme).toHaveBeenCalledWith("dark");
    invoke(control("select", "system"), "onValueChange", "bogus");
    expect(h.setTheme).toHaveBeenCalledTimes(1);

    invoke(control("select", "locale"), "onValueChange", "12-hour");
    expect(h.updateSettings).toHaveBeenCalledWith({ timestampFormat: "12-hour" });
    invoke(control("select", "locale"), "onValueChange", "bogus");

    invoke(
      control("switch", "Wrap code, tables, diffs, and file previews by default"),
      "onCheckedChange",
      true,
    );
    expect(h.updateSettings).toHaveBeenCalledWith({ wordWrap: true });

    invoke(control("switch", "Hide whitespace changes by default"), "onCheckedChange", true);
    expect(h.updateSettings).toHaveBeenCalledWith({ diffIgnoreWhitespace: true });

    invoke(control("switch", "Stream assistant messages"), "onCheckedChange", true);
    expect(h.updateSettings).toHaveBeenCalledWith({ enableAssistantStreaming: true });

    invoke(control("switch", "Check provider versions"), "onCheckedChange", false);
    expect(h.updateSettings).toHaveBeenCalledWith({ enableProviderUpdateChecks: false });

    invoke(control("switch", "Open the task panel automatically"), "onCheckedChange", true);
    expect(h.updateSettings).toHaveBeenCalledWith({ autoOpenPlanSidebar: true });

    invoke(control("switch", "Confirm thread archiving"), "onCheckedChange", false);
    expect(h.updateSettings).toHaveBeenCalledWith({ confirmThreadArchive: false });

    invoke(control("switch", "Confirm thread deletion"), "onCheckedChange", false);
    expect(h.updateSettings).toHaveBeenCalledWith({ confirmThreadDelete: false });

    invoke(control("select", "local"), "onValueChange", "worktree");
    expect(h.updateSettings).toHaveBeenCalledWith({ defaultThreadEnvMode: "worktree" });
    invoke(control("select", "local"), "onValueChange", "bogus");

    invoke(control("draft-input", "Add project base directory"), "onCommit", "~/somewhere");
    expect(h.updateSettings).toHaveBeenCalledWith({ addProjectBaseDirectory: "~/somewhere" });

    // Hosted update-track select: picking the current channel is a no-op,
    // picking the other channel navigates to the channel-selection URL.
    invoke(control("select", "latest"), "onValueChange", "latest");
    expect(assignSpy).not.toHaveBeenCalled();
    invoke(control("select", "latest"), "onValueChange", "nightly");
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(String(assignSpy.mock.calls[0]?.[0])).toContain("channel=nightly");
  });

  it("updates the text generation model through the pickers", () => {
    h.serverProviders = [
      makeServerProvider({ instanceId: "codex", driver: CODEX_DRIVER }),
      makeServerProvider({ instanceId: "claudeAgent", driver: CLAUDE_DRIVER }),
    ];
    render(<GeneralSettingsPanel />);

    expect(h.modelPickers).toHaveLength(1);
    expect(h.traitsPickers).toHaveLength(1);

    const picker = h.modelPickers[0]!;
    (picker.onInstanceModelChange as (instanceId: unknown, model: string) => void)(
      CODEX_INSTANCE_ID,
      "model-beta",
    );
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    const patch = h.updateSettings.mock.calls[0]?.[0] as {
      textGenerationModelSelection?: { model?: string };
    };
    expect(patch.textGenerationModelSelection?.model).toBe("model-beta");

    const traits = h.traitsPickers[0]!;
    (traits.onPromptChange as () => void)();
    (traits.onModelOptionsChange as (options: unknown) => void)([
      { id: "reasoning", value: "high" },
    ]);
    expect(h.updateSettings).toHaveBeenCalledTimes(2);
  });

  it("renders changed settings with reset actions and restores them", () => {
    h.theme = "dark";
    h.settings = changedSettings();
    h.observability = {
      localTracingEnabled: true,
      otlpTracesEnabled: true,
      otlpTracesUrl: "https://otel.example.com/v1/traces",
      otlpMetricsEnabled: true,
      otlpMetricsUrl: "https://otel.example.com/v1/metrics",
    };

    const markup = render(<GeneralSettingsPanel />);

    expect(markup).toContain("{traces,metrics}");
    expect(markup).toContain("Start from origin");
    expect(findControls("switch", "Start new worktrees from origin by default")).toHaveLength(1);

    invoke(control("button", "Reset theme to default"), "onClick");
    expect(h.setTheme).toHaveBeenCalledWith("system");

    invoke(control("button", "Reset time format to default"), "onClick");
    expect(h.updateSettings).toHaveBeenCalledWith({
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
    });

    invoke(control("button", "Reset word wrapping to default"), "onClick");
    invoke(control("button", "Reset diff whitespace changes to default"), "onClick");
    invoke(control("button", "Reset assistant output to default"), "onClick");
    invoke(control("button", "Reset provider update checks to default"), "onClick");
    invoke(control("button", "Reset auto-open task panel to default"), "onClick");
    invoke(control("button", "Reset new threads to default"), "onClick");
    invoke(control("button", "Reset new worktrees start from origin to default"), "onClick");
    invoke(control("button", "Reset add project base directory to default"), "onClick");
    invoke(control("button", "Reset archive confirmation to default"), "onClick");
    invoke(control("button", "Reset delete confirmation to default"), "onClick");
    invoke(control("button", "Reset text generation model to default"), "onClick");
    expect(h.updateSettings).toHaveBeenCalledTimes(12);

    invoke(
      control("switch", "Start new worktrees from origin by default"),
      "onCheckedChange",
      false,
    );
    expect(h.updateSettings).toHaveBeenCalledWith({ newWorktreesStartFromOrigin: false });
  });

  describe("desktop update section", () => {
    function stubDesktopWindow(bridge: Record<string, unknown>, confirmResult = true) {
      const confirmSpy = vi.fn(() => confirmResult);
      vi.stubGlobal("window", {
        desktopBridge: bridge,
        confirm: confirmSpy,
        location: { assign: vi.fn() },
      });
      return { confirmSpy };
    }

    it("checks for updates and reports failures", async () => {
      const bridge = {
        checkForUpdate: vi
          .fn()
          .mockResolvedValueOnce({ checked: true, state: {} })
          .mockResolvedValueOnce({ checked: false, state: { message: "No feed available." } })
          .mockRejectedValueOnce(new Error("network down")),
        setUpdateChannel: vi.fn().mockResolvedValue(undefined),
      };
      stubDesktopWindow(bridge);
      h.updateState = makeUpdateState({ status: "idle" });

      const markup = render(<GeneralSettingsPanel />);
      expect(markup).toContain("Update track");
      expect(markup).toContain("Stable");

      const button = control("button", "Check for Updates");
      invoke(button, "onClick");
      await flush();
      expect(h.toastAdd).not.toHaveBeenCalled();

      invoke(button, "onClick");
      await flush();
      expect(h.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not check for updates" }),
      );

      invoke(button, "onClick");
      await flush();
      expect(h.toastAdd).toHaveBeenCalledTimes(2);
      expect(bridge.checkForUpdate).toHaveBeenCalledTimes(3);

      // Update track changes go through the desktop bridge.
      invoke(control("select", "latest"), "onValueChange", "latest");
      expect(bridge.setUpdateChannel).not.toHaveBeenCalled();
      invoke(control("select", "latest"), "onValueChange", "nightly");
      await flush();
      expect(bridge.setUpdateChannel).toHaveBeenCalledWith("nightly");
    });

    it("reports update-track change failures", async () => {
      const bridge = {
        checkForUpdate: vi.fn().mockResolvedValue({ checked: true, state: {} }),
        setUpdateChannel: vi.fn().mockRejectedValue(new Error("switch failed")),
      };
      stubDesktopWindow(bridge);
      h.updateState = makeUpdateState({ status: "idle", channel: "nightly" });

      const markup = render(<GeneralSettingsPanel />);
      expect(markup).toContain("Nightly");

      invoke(control("select", "nightly"), "onValueChange", "latest");
      await flush();
      expect(h.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not change update track" }),
      );
    });

    it("downloads available updates and surfaces download failures", async () => {
      const bridge = {
        downloadUpdate: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("disk full")),
        checkForUpdate: vi.fn(),
        setUpdateChannel: vi.fn(),
      };
      stubDesktopWindow(bridge);
      h.updateState = makeUpdateState({ status: "available", availableVersion: "10.0.0" });

      const markup = render(<GeneralSettingsPanel />);
      expect(markup).toContain("Update available.");
      expect(markup).toContain("Update 10.0.0 ready to download");

      const button = control("button", "Download");
      invoke(button, "onClick");
      await flush();
      expect(h.toastAdd).not.toHaveBeenCalled();

      invoke(button, "onClick");
      await flush();
      expect(h.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not download update" }),
      );
      expect(bridge.downloadUpdate).toHaveBeenCalledTimes(2);
    });

    it("asks for confirmation before installing a downloaded update", async () => {
      const bridge = {
        installUpdate: vi.fn().mockRejectedValue(new Error("install failed")),
        checkForUpdate: vi.fn(),
        setUpdateChannel: vi.fn(),
      };
      const { confirmSpy } = stubDesktopWindow(bridge, false);
      h.updateState = makeUpdateState({
        status: "downloaded",
        availableVersion: "10.0.0",
        downloadedVersion: "10.0.0",
      });

      render(<GeneralSettingsPanel />);
      const button = control("button", "Install");
      invoke(button, "onClick");
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(bridge.installUpdate).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      invoke(button, "onClick");
      await flush();
      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
      expect(h.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not install update" }),
      );
    });

    it("shows the downloading state as disabled", () => {
      stubDesktopWindow({ checkForUpdate: vi.fn(), setUpdateChannel: vi.fn() });
      h.updateState = makeUpdateState({
        status: "downloading",
        availableVersion: "10.0.0",
        downloadPercent: 42,
      });

      const markup = render(<GeneralSettingsPanel />);
      expect(markup).toContain("Downloading…");
      expect(markup).toContain("Downloading update (42%)");
    });
  });
});

describe("useSettingsRestore", () => {
  interface RestoreProbeResult {
    changedSettingLabels: ReadonlyArray<string>;
    restoreDefaults: () => Promise<void>;
  }

  function captureRestore(onRestored?: () => void): RestoreProbeResult {
    let captured: RestoreProbeResult | null = null;
    function Probe() {
      captured = useSettingsRestore(onRestored) as RestoreProbeResult;
      return null;
    }
    render(<Probe />);
    if (captured === null) {
      throw new Error("useSettingsRestore probe did not render");
    }
    return captured;
  }

  it("reports no changed settings for defaults and skips the confirm dialog", async () => {
    const confirmSpy = vi.fn(async () => true);
    h.localApi = { dialogs: { confirm: confirmSpy } };
    const restore = captureRestore();

    expect(restore.changedSettingLabels).toEqual([]);
    await restore.restoreDefaults();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("lists every changed setting label", () => {
    h.theme = "dark";
    h.settings = changedSettings();
    const restore = captureRestore();

    expect(restore.changedSettingLabels).toEqual([
      "Theme",
      "Time format",
      "Visible threads",
      "Word wrap",
      "Diff whitespace changes",
      "Auto-open task panel",
      "Assistant output",
      "Automatic Git fetch interval",
      "New thread mode",
      "New worktrees start from origin",
      "Add project base directory",
      "Archive confirmation",
      "Delete confirmation",
      "Git writing model",
    ]);
  });

  it("restores defaults after confirmation and notifies the caller", async () => {
    h.theme = "dark";
    h.settings = changedSettings();
    const confirmSpy = vi.fn(async (_message: string) => true);
    h.localApi = { dialogs: { confirm: confirmSpy } };
    const onRestored = vi.fn();
    const restore = captureRestore(onRestored);

    await restore.restoreDefaults();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain("Restore default settings?");
    expect(h.setTheme).toHaveBeenCalledWith("system");
    expect(h.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
        wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
        confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      }),
    );
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the user cancels the confirmation", async () => {
    h.theme = "dark";
    h.settings = changedSettings();
    const confirmSpy = vi.fn(async () => false);
    h.localApi = { dialogs: { confirm: confirmSpy } };
    const restore = captureRestore();

    await restore.restoreDefaults();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.setTheme).not.toHaveBeenCalled();
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("fails when no local API is available", async () => {
    h.theme = "dark";
    h.settings = changedSettings();
    h.localApi = undefined;
    const restore = captureRestore();

    await expect(restore.restoreDefaults()).rejects.toThrow("Local API not found");
  });
});

describe("ProviderSettingsPanel", () => {
  function baseProviderSettings(): UnifiedSettings {
    return {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: CODEX_DRIVER,
          enabled: true,
          config: { enabled: true },
        },
        [ProviderInstanceId.make("codex_personal")]: {
          driver: CODEX_DRIVER,
          displayName: "Personal Codex",
          enabled: true,
          config: { enabled: true },
        },
        [ProviderInstanceId.make("cursor_alt")]: {
          driver: CURSOR_DRIVER,
          displayName: "Cursor Sandbox",
          enabled: true,
          config: { enabled: true },
        },
      },
      providerModelPreferences: {
        [ProviderInstanceId.make("codex")]: {
          hiddenModels: ["model-hidden"],
          modelOrder: ["model-beta", "model-alpha"],
        },
      },
      favorites: [
        { provider: ProviderInstanceId.make("codex"), model: "model-alpha" },
        { provider: ProviderInstanceId.make("codex_personal"), model: "model-beta" },
      ],
    };
  }

  it("renders provider rows including custom and orphaned instances", () => {
    h.settings = baseProviderSettings();
    h.serverProviders = [
      makeServerProvider({
        instanceId: "codex",
        driver: CODEX_DRIVER,
        behindLatest: true,
        checkedAt: "2026-06-27T09:00:00.000Z",
      }),
      makeServerProvider({ instanceId: "claudeAgent", driver: CLAUDE_DRIVER }),
    ];

    const markup = render(<ProviderSettingsPanel />);
    expect(markup).toContain("Providers");
    expect(markup).toContain("Checked");

    const cardIds = h.instanceCards.map((card) => String(card.instanceId));
    // Cursor's default slot is hidden (no live cursor provider), but the
    // custom cursor instance still renders as an orphaned row.
    expect(cardIds).toEqual([
      "codex",
      "codex_personal",
      "claudeAgent",
      "grok",
      "opencode",
      "cursor_alt",
    ]);

    const codexCard = h.instanceCards.find((card) => String(card.instanceId) === "codex")!;
    expect(codexCard.headerAction).not.toBeNull();
    expect(codexCard.hiddenModels).toEqual(["model-hidden"]);
    expect(codexCard.favoriteModels).toEqual(["model-alpha"]);

    const grokCard = h.instanceCards.find((card) => String(card.instanceId) === "grok")!;
    expect(grokCard.headerAction).toBeNull();
    expect(grokCard.onDelete).toBeUndefined();

    const personalCard = h.instanceCards.find(
      (card) => String(card.instanceId) === "codex_personal",
    )!;
    expect(typeof personalCard.onDelete).toBe("function");
  });

  it("routes instance card callbacks into settings patches", () => {
    h.settings = baseProviderSettings();
    h.serverProviders = [
      makeServerProvider({ instanceId: "codex", driver: CODEX_DRIVER, behindLatest: true }),
    ];

    render(<ProviderSettingsPanel />);
    const codexCard = h.instanceCards.find((card) => String(card.instanceId) === "codex")!;
    const personalCard = h.instanceCards.find(
      (card) => String(card.instanceId) === "codex_personal",
    )!;

    // Disabling the instance that currently backs text generation clears the
    // text-generation model selection back to its default.
    (codexCard.onUpdate as (next: unknown) => void)({
      driver: CODEX_DRIVER,
      enabled: false,
      config: { enabled: false },
    });
    const disablePatch = h.updateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(disablePatch.textGenerationModelSelection).toEqual(
      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    );
    expect(disablePatch.providerInstances).toBeDefined();

    (codexCard.onUpdate as (next: unknown) => void)({
      driver: CODEX_DRIVER,
      enabled: true,
      config: { enabled: true },
    });
    const enablePatch = h.updateSettings.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(enablePatch.textGenerationModelSelection).toBeUndefined();

    (personalCard.onDelete as () => void)();
    const deletePatch = h.updateSettings.mock.calls[2]?.[0] as {
      providerInstances: Record<string, unknown>;
      favorites: ReadonlyArray<{ provider: string }>;
    };
    expect(Object.keys(deletePatch.providerInstances)).not.toContain("codex_personal");
    expect(deletePatch.favorites.every((entry) => entry.provider !== "codex_personal")).toBe(true);

    (codexCard.onHiddenModelsChange as (models: ReadonlyArray<string>) => void)([
      "model-x",
      "model-x",
      " ",
    ]);
    const hiddenPatch = h.updateSettings.mock.calls[3]?.[0] as {
      providerModelPreferences: Record<string, { hiddenModels: ReadonlyArray<string> }>;
    };
    expect(hiddenPatch.providerModelPreferences["codex"]?.hiddenModels).toEqual(["model-x"]);

    (codexCard.onModelOrderChange as (order: ReadonlyArray<string>) => void)([]);
    const orderPatch = h.updateSettings.mock.calls[4]?.[0] as {
      providerModelPreferences: Record<string, unknown>;
    };
    expect(orderPatch.providerModelPreferences["codex"]).toBeDefined();

    (codexCard.onFavoriteModelsChange as (models: ReadonlyArray<string>) => void)([
      "model-y",
      "",
      "model-y",
    ]);
    const favoritesPatch = h.updateSettings.mock.calls[5]?.[0] as {
      favorites: ReadonlyArray<{ provider: string; model: string }>;
    };
    expect(favoritesPatch.favorites).toContainEqual({ provider: "codex", model: "model-y" });
    expect(favoritesPatch.favorites).toContainEqual({
      provider: "codex_personal",
      model: "model-beta",
    });

    // The default-slot reset action restores the legacy provider defaults.
    const headerAction = codexCard.headerAction as ReactElement<{ onClick: () => void }>;
    headerAction.props.onClick();
    const resetPatch = h.updateSettings.mock.calls[6]?.[0] as Record<string, unknown>;
    expect(resetPatch.providers).toBeDefined();
    expect(Object.keys(resetPatch.providerInstances as Record<string, unknown>)).not.toContain(
      "codex",
    );

    (codexCard.onExpandedChange as (open: boolean) => void)(true);
  });

  it("runs one-click provider updates and reports failures", async () => {
    h.settings = baseProviderSettings();
    h.serverProviders = [
      makeServerProvider({ instanceId: "codex", driver: CODEX_DRIVER, behindLatest: true }),
    ];

    render(<ProviderSettingsPanel />);
    const codexCard = h.instanceCards.find((card) => String(card.instanceId) === "codex")!;
    expect(typeof codexCard.onRunUpdate).toBe("function");
    expect(codexCard.isUpdating).toBe(false);

    (codexCard.onRunUpdate as () => void)();
    await flush();
    expect(h.updateProviderCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { provider: CODEX_DRIVER, instanceId: ProviderInstanceId.make("codex") },
    });
    expect(h.toastAdd).not.toHaveBeenCalled();

    h.updateProviderCommand.mockResolvedValueOnce({
      _tag: "Failure",
      cause: new Error("update exploded"),
    });
    (codexCard.onRunUpdate as () => void)();
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not update Codex",
        description: "update exploded",
      }),
    );

    h.updateProviderCommand.mockResolvedValueOnce({ _tag: "Failure", interrupted: true });
    (codexCard.onRunUpdate as () => void)();
    await flush();
    expect(h.toastAdd).toHaveBeenCalledTimes(1);
  });

  it("marks a provider as updating while its update command is active", () => {
    h.settings = baseProviderSettings();
    h.serverProviders = [
      makeServerProvider({
        instanceId: "codex",
        driver: CODEX_DRIVER,
        behindLatest: true,
        updateRunning: true,
      }),
    ];

    render(<ProviderSettingsPanel />);
    const codexCard = h.instanceCards.find((card) => String(card.instanceId) === "codex")!;
    expect(codexCard.isUpdating).toBe(true);
    // The one-click update guard refuses to start while an update is running.
    (codexCard.onRunUpdate as () => void)();
    expect(h.updateProviderCommand).not.toHaveBeenCalled();
  });

  it("refreshes provider status once at a time", async () => {
    h.settings = baseProviderSettings();
    h.serverProviders = [makeServerProvider({ instanceId: "codex", driver: CODEX_DRIVER })];
    let resolveRefresh: (value: unknown) => void = () => {};
    h.refreshProvidersCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    render(<ProviderSettingsPanel />);
    const refreshButton = control("button", "Refresh provider status");
    invoke(refreshButton, "onClick");
    invoke(refreshButton, "onClick");
    expect(h.refreshProvidersCommand).toHaveBeenCalledTimes(1);

    resolveRefresh({ _tag: "Success", value: { providers: [] } });
    await flush();

    invoke(control("button", "Add provider instance"), "onClick");
  });

  it("logs refresh failures without toasting", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.settings = baseProviderSettings();
    h.serverProviders = [makeServerProvider({ instanceId: "codex", driver: CODEX_DRIVER })];
    h.refreshProvidersCommand.mockResolvedValue({
      _tag: "Failure",
      cause: new Error("refresh failed"),
    });

    render(<ProviderSettingsPanel />);
    invoke(control("button", "Refresh provider status"), "onClick");
    await flush();
    expect(warnSpy).toHaveBeenCalledWith("Failed to refresh providers", expect.anything());
    expect(h.toastAdd).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips refresh and updates when no primary environment is connected", async () => {
    h.primaryEnvironment = null;
    h.settings = baseProviderSettings();
    h.serverProviders = [
      makeServerProvider({ instanceId: "codex", driver: CODEX_DRIVER, behindLatest: true }),
    ];

    render(<ProviderSettingsPanel />);
    invoke(control("button", "Refresh provider status"), "onClick");
    await flush();
    expect(h.refreshProvidersCommand).not.toHaveBeenCalled();

    const codexCard = h.instanceCards.find((card) => String(card.instanceId) === "codex")!;
    (codexCard.onRunUpdate as () => void)();
    await flush();
    expect(h.updateProviderCommand).not.toHaveBeenCalled();
  });
});

describe("ArchivedThreadsPanel", () => {
  const env1 = EnvironmentId.make("environment-one");
  const env2 = EnvironmentId.make("environment-two");

  function archivedSnapshots() {
    return [
      {
        environmentId: env1,
        snapshot: {
          projects: [{ id: "project-a", title: "Alpha Project", workspaceRoot: "/work/alpha" }],
          threads: [
            {
              id: "thread-old",
              projectId: "project-a",
              title: "Older thread",
              archivedAt: "2026-06-01T00:00:00.000Z",
              createdAt: "2026-05-01T00:00:00.000Z",
            },
            {
              id: "thread-new",
              projectId: "project-a",
              title: "Newer thread",
              archivedAt: null,
              createdAt: "2026-06-20T00:00:00.000Z",
            },
          ],
        },
      },
      {
        environmentId: env2,
        snapshot: {
          projects: [
            { id: "project-b", title: "Beta Project", workspaceRoot: "/work/beta" },
            { id: "project-empty", title: "No Threads", workspaceRoot: "/work/none" },
          ],
          threads: [
            {
              id: "thread-b",
              projectId: "project-b",
              title: "Beta thread",
              archivedAt: "2026-06-10T00:00:00.000Z",
              createdAt: "2026-06-05T00:00:00.000Z",
            },
          ],
        },
      },
    ];
  }

  beforeEach(() => {
    h.projects = [{ environmentId: env1 }, { environmentId: env2 }];
  });

  it("shows the loading state", () => {
    h.archive.isLoading = true;
    const markup = render(<ArchivedThreadsPanel />);
    expect(markup).toContain("Loading archived threads");
    expect(markup).toContain("Checking connected environments.");
  });

  it("shows the error state", () => {
    h.archive.error = "connection lost";
    const markup = render(<ArchivedThreadsPanel />);
    expect(markup).toContain("Could not load archived threads");
    expect(markup).toContain("connection lost");
  });

  it("shows the empty state", () => {
    const markup = render(<ArchivedThreadsPanel />);
    expect(markup).toContain("No archived threads");
    expect(markup).toContain("Archived threads will appear here.");
  });

  it("groups archived threads by project, newest first", () => {
    h.archive.snapshots = archivedSnapshots();
    const markup = render(<ArchivedThreadsPanel />);

    expect(markup).toContain("Alpha Project");
    expect(markup).toContain("Beta Project");
    expect(markup).not.toContain("No Threads");
    // Newest archive key (createdAt fallback) sorts first.
    expect(markup.indexOf("Newer thread")).toBeLessThan(markup.indexOf("Older thread"));
    expect(markup).toContain("Archived");
    expect(markup).toContain("Created");
  });

  it("unarchives a thread and refreshes on success", async () => {
    h.archive.snapshots = archivedSnapshots();
    render(<ArchivedThreadsPanel />);

    const unarchiveButtons = findControls("button", "Unarchive");
    expect(unarchiveButtons.length).toBe(3);
    invoke(unarchiveButtons[0]!, "onClick");
    await flush();
    expect(h.unarchiveThread).toHaveBeenCalledWith({
      environmentId: env1,
      threadId: "thread-new",
    });
    expect(h.archive.refresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces unarchive failures as toasts", async () => {
    h.archive.snapshots = archivedSnapshots();
    h.unarchiveThread.mockResolvedValue({ _tag: "Failure", cause: new Error("nope") });
    render(<ArchivedThreadsPanel />);

    invoke(findControls("button", "Unarchive")[0]!, "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to unarchive thread", description: "nope" }),
    );
    expect(h.archive.refresh).not.toHaveBeenCalled();

    h.toastAdd.mockClear();
    h.unarchiveThread.mockResolvedValue({ _tag: "Failure", interrupted: true });
    invoke(findControls("button", "Unarchive")[1]!, "onClick");
    await flush();
    expect(h.toastAdd).not.toHaveBeenCalled();
  });

  it("drives the context menu actions", async () => {
    h.archive.snapshots = archivedSnapshots();
    const showSpy = vi.fn();
    h.localApi = { contextMenu: { show: showSpy } };
    render(<ArchivedThreadsPanel />);

    const row = h.rows.find((entry) => typeof entry.onContextMenu === "function");
    expect(row).toBeDefined();
    const fireContextMenu = () =>
      (row!.onContextMenu as (event: unknown) => void)({
        preventDefault: () => {},
        clientX: 11,
        clientY: 22,
      });

    // Unarchive via context menu.
    showSpy.mockResolvedValueOnce("unarchive");
    fireContextMenu();
    await flush();
    expect(showSpy).toHaveBeenCalledWith(
      [
        { id: "unarchive", label: "Unarchive" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      { x: 11, y: 22 },
    );
    expect(h.unarchiveThread).toHaveBeenCalledTimes(1);
    expect(h.archive.refresh).toHaveBeenCalledTimes(1);

    // Unarchive failure toasts.
    showSpy.mockResolvedValueOnce("unarchive");
    h.unarchiveThread.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("locked") });
    fireContextMenu();
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to unarchive thread", description: "locked" }),
    );

    // Delete via context menu.
    showSpy.mockResolvedValueOnce("delete");
    fireContextMenu();
    await flush();
    expect(h.confirmAndDeleteThread).toHaveBeenCalledTimes(1);
    expect(h.archive.refresh).toHaveBeenCalledTimes(2);

    // Delete failure toasts.
    showSpy.mockResolvedValueOnce("delete");
    h.confirmAndDeleteThread.mockResolvedValueOnce({
      _tag: "Failure",
      cause: new Error("cannot delete"),
    });
    fireContextMenu();
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to delete thread", description: "cannot delete" }),
    );

    // Dismissing the menu does nothing.
    showSpy.mockResolvedValueOnce(null);
    fireContextMenu();
    await flush();
    expect(h.unarchiveThread).toHaveBeenCalledTimes(2);
    expect(h.confirmAndDeleteThread).toHaveBeenCalledTimes(2);

    // The context-menu handler itself failing surfaces a toast.
    showSpy.mockRejectedValueOnce(new Error("menu exploded"));
    fireContextMenu();
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Archived thread action failed",
        description: "menu exploded",
      }),
    );
  });

  it("ignores context menus when no local API is present", async () => {
    h.archive.snapshots = archivedSnapshots();
    h.localApi = undefined;
    render(<ArchivedThreadsPanel />);

    const row = h.rows.find((entry) => typeof entry.onContextMenu === "function");
    (row!.onContextMenu as (event: unknown) => void)({
      preventDefault: () => {},
      clientX: 0,
      clientY: 0,
    });
    await flush();
    expect(h.unarchiveThread).not.toHaveBeenCalled();
  });
});
