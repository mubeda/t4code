import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Instrumented-hooks render tests for {@link ThreadComposer}. The composer is a
 * React Native component; following the repo pattern (see
 * `apps/web/.../ChatView.hooks.test.tsx` and `AddProjectScreen.test.tsx`) it is
 * rendered with `renderToStaticMarkup` while a partial `vi.mock("react")`
 * captures effects and lets scenarios seed `useState`. Native/leaf modules are
 * mocked; the pure logic modules (`modelOptions`, `providerOptions`,
 * `shared/composerTrigger`, `shared/searchRanking`) stay real so their branches
 * are exercised for free.
 */

const h = vi.hoisted(() => {
  type Matcher = (initial: unknown) => boolean;
  const state = {
    // react instrumentation
    stateSeeds: [] as Array<{ match: Matcher; value: unknown }>,
    setStateCalls: [] as Array<{ initial: unknown; next: unknown; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
    // captured child props
    entries: [] as Array<{ kind: string; props: Record<string, unknown> }>,
    // environment knobs
    colorScheme: "light" as "light" | "dark",
    liquidGlassSupported: false,
    pathSearch: { entries: [] as Array<{ path: string; kind: string }>, isPending: false },
    reset() {
      state.stateSeeds.length = 0;
      state.setStateCalls.length = 0;
      state.effects.length = 0;
      state.entries.length = 0;
      state.colorScheme = "light";
      state.liquidGlassSupported = false;
      state.pathSearch = { entries: [], isPending: false };
    },
    record(kind: string, props: unknown) {
      if (props && typeof props === "object") {
        state.entries.push({ kind, props: props as Record<string, unknown> });
      }
    },
    filter(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      return state.entries
        .filter((entry) => entry.kind === kind && (predicate?.(entry.props) ?? true))
        .map((entry) => entry.props);
    },
    find(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      const found = state.entries.find(
        (entry) => entry.kind === kind && (predicate?.(entry.props) ?? true),
      )?.props;
      if (!found) throw new Error(`No recorded "${kind}" element matched`);
      return found;
    },
    runEffects(): Array<() => void> {
      const cleanups: Array<() => void> = [];
      for (const effect of Array.from(state.effects)) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return cleanups;
    },
  };
  return state;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;
  const useState = (initial?: unknown) => {
    const resolved = resolveInitial(initial);
    const seedIndex = h.stateSeeds.findIndex((seed) => seed.match(resolved));
    const value = seedIndex >= 0 ? h.stateSeeds.splice(seedIndex, 1)[0]!.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      h.setStateCalls.push({ initial: resolved, next, applied });
    };
    return [value, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    h.effects.push(effect);
  };
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useLayoutEffect: useEffect as typeof actual.useLayoutEffect,
  };
});

vi.mock("@callstack/liquid-glass", () => ({
  get isLiquidGlassSupported() {
    return h.liquidGlassSupported;
  },
  LiquidGlassView: (props: { readonly children?: ReactNode }) => (
    <div data-liquid-glass="true">{props.children}</div>
  ),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => <i data-activity-indicator="true" />,
  Image: (props: Record<string, unknown>) => {
    h.record("Image", props);
    return <i data-image="true" />;
  },
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.record("Pressable", props);
    return <button type="button">{props.children}</button>;
  },
  View: (props: { readonly children?: ReactNode } & Record<string, unknown>) => (
    <div>{props.children}</div>
  ),
  useColorScheme: () => h.colorScheme,
}));

vi.mock("react-native-image-viewing", () => ({
  default: (props: Record<string, unknown>) => {
    h.record("ImageViewing", props);
    return props["visible"] ? <div data-image-viewing="true" /> : null;
  },
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: () => "#101010",
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
}));

vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: (props: Record<string, unknown>) => {
    h.record("ComposerAttachmentStrip", props);
    return <div data-attachment-strip="true" />;
  },
}));

vi.mock("../../components/ComposerEditor", () => ({
  ComposerEditor: (props: Record<string, unknown>) => {
    h.record("ComposerEditor", props);
    return <div data-composer-editor="true" />;
  },
}));

vi.mock("../../components/ComposerToolbarTrigger", () => ({
  ComposerToolbarButton: (props: Record<string, unknown>) => {
    h.record("ComposerToolbarButton", props);
    return <button type="button" data-toolbar-button={String(props["accessibilityLabel"] ?? "")} />;
  },
  ComposerToolbarRow: (props: { readonly children?: ReactNode }) => (
    <div data-toolbar-row="true">{props.children}</div>
  ),
  ComposerToolbarScroller: (props: { readonly children?: ReactNode }) => (
    <div data-toolbar-scroller="true">{props.children}</div>
  ),
  ComposerToolbarTrigger: (props: Record<string, unknown>) => {
    h.record("ComposerToolbarTrigger", props);
    return <div data-toolbar-trigger={String(props["label"] ?? "")} />;
  },
}));

vi.mock("../../components/ControlPill", () => ({
  ControlPill: (props: Record<string, unknown>) => {
    h.record("ControlPill", props);
    return <button type="button" data-control-pill={String(props["icon"] ?? "")} />;
  },
  ControlPillMenu: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.record("ControlPillMenu", props);
    return <div data-control-pill-menu="true">{props.children}</div>;
  },
}));

vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: (props: Record<string, unknown>) => {
    h.record("ProviderIcon", props);
    return <i data-provider-icon={String(props["provider"] ?? "")} />;
  },
}));

vi.mock("./ComposerCommandPopover", () => ({
  ComposerCommandPopover: (props: Record<string, unknown>) => {
    h.record("ComposerCommandPopover", props);
    return <div data-command-popover="true" />;
  },
}));

vi.mock("../../state/use-composer-path-search", () => ({
  useComposerPathSearch: () => h.pathSearch,
}));

import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const ENV = EnvironmentId.make("env-1");
const INSTANCE = ProviderInstanceId.make("codex");

function modelSelection(overrides: Partial<ModelSelection> = {}): ModelSelection {
  return { instanceId: INSTANCE, model: "gpt-5", ...overrides } as ModelSelection;
}

function makeThreadShell(
  overrides: {
    readonly sessionStatus?: string | null;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode | undefined;
    readonly modelSelection?: ModelSelection;
  } = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: overrides.modelSelection ?? modelSelection(),
    runtimeMode: overrides.runtimeMode ?? "full-access",
    interactionMode: overrides.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    session:
      overrides.sessionStatus === undefined || overrides.sessionStatus === null
        ? null
        : { status: overrides.sessionStatus },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as unknown as OrchestrationThreadShell;
}

function makeServerConfig(): T3ServerConfig {
  return {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [
          { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null },
          { slug: "gpt-5-mini", name: "GPT-5 mini", isCustom: false, capabilities: null },
        ],
        slashCommands: [{ name: "review", description: "Review the diff" }],
        skills: [
          {
            name: "web-search",
            displayName: "Web Search",
            enabled: true,
            shortDescription: "Search the web",
            description: "Search the internet for information",
          },
          {
            name: "disabled-skill",
            displayName: "Disabled",
            enabled: false,
            shortDescription: "off",
            description: "off",
          },
        ],
      },
    ],
  } as unknown as T3ServerConfig;
}

type DraftAttachment = ThreadComposerProps["draftAttachments"][number];

function attachment(id: string, previewUri: string): DraftAttachment {
  return {
    type: "image",
    id,
    previewUri,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 10,
    dataUrl: `data:image/png;base64,${id}`,
  } as DraftAttachment;
}

function attachments(...ids: ReadonlyArray<string>): ReadonlyArray<DraftAttachment> {
  return ids.map((id) => attachment(id, `uri-${id}`));
}

function baseProps(overrides: Partial<ThreadComposerProps> = {}): ThreadComposerProps {
  return {
    draftMessage: "",
    draftAttachments: [],
    placeholder: "Message",
    connectionState: "connected",
    connectionError: null,
    environmentLabel: "Local",
    selectedThread: makeThreadShell(),
    serverConfig: makeServerConfig(),
    queueCount: 0,
    activeThreadBusy: false,
    environmentId: ENV,
    projectCwd: "/repo",
    onChangeDraftMessage: () => undefined,
    onPickDraftImages: () => Promise.resolve(),
    onNativePasteImages: () => Promise.resolve(),
    onRemoveDraftImage: () => undefined,
    onStopThread: () => undefined,
    onSendMessage: () => Promise.resolve(null),
    onUpdateModelSelection: () => undefined,
    onUpdateRuntimeMode: () => undefined,
    onUpdateInteractionMode: () => undefined,
    onReconnectEnvironment: () => undefined,
    ...overrides,
  };
}

function render(props: ThreadComposerProps): string {
  h.entries.length = 0;
  h.setStateCalls.length = 0;
  h.effects.length = 0;
  return renderToStaticMarkup(<ThreadComposer {...props} />);
}

/** Seed the first `useState(false)` (isFocused) so the expanded layout renders. */
function seedExpanded(): void {
  h.stateSeeds.push({ match: (value) => value === false, value: true });
}

beforeEach(() => {
  h.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThreadComposer collapsed rendering", () => {
  it("renders the collapsed pill with a send control when there is content", () => {
    const markup = render(baseProps({ draftMessage: "hello" }));
    expect(markup).toContain("data-composer-editor");
    // Collapsed: no toolbar row.
    expect(markup).not.toContain("data-toolbar-row");
    const send = h.find("ControlPill", (props) => props["icon"] === "arrow.up");
    expect(send["disabled"]).toBe(false);
  });

  it("disables the collapsed send control when the draft is empty", () => {
    render(baseProps({ draftMessage: "   " }));
    const send = h.find("ControlPill", (props) => props["icon"] === "arrow.up");
    expect(send["disabled"]).toBe(true);
  });

  it("shows a stop control while the session is running", () => {
    render(baseProps({ selectedThread: makeThreadShell({ sessionStatus: "running" }) }));
    const stop = h.find("ControlPill", (props) => props["icon"] === "stop.fill");
    expect(stop["variant"]).toBe("danger");
  });

  it("renders collapsed attachment thumbnails with an overflow badge", () => {
    const markup = render(baseProps({ draftAttachments: attachments("a", "b", "c", "d") }));
    // Only the first three thumbnails render, plus the "+1" overflow badge.
    expect(h.filter("Image")).toHaveLength(3);
    expect(markup).toContain("+1");
  });
});

describe("ThreadComposer connection status", () => {
  const cases: Array<{
    readonly state: ThreadComposerProps["connectionState"];
    readonly error: string | null;
    readonly expected: string;
  }> = [
    { state: "connecting", error: null, expected: "Reconnecting to Local..." },
    { state: "reconnecting", error: "boom", expected: "Failed to connect. Retrying Local..." },
    { state: "offline", error: null, expected: "You are offline" },
    { state: "error", error: "nope", expected: "Failed to connect to Local: nope" },
    { state: "error", error: null, expected: "Failed to connect to Local" },
    { state: "available", error: null, expected: "Local is not connected" },
  ];

  for (const testCase of cases) {
    it(`labels the ${testCase.state} state${testCase.error ? " with an error" : ""}`, () => {
      const markup = render(
        baseProps({ connectionState: testCase.state, connectionError: testCase.error }),
      );
      expect(markup).toContain(testCase.expected);
    });
  }

  it("omits the status pill and reconnect handler while connected", () => {
    const markup = render(baseProps({ connectionState: "connected" }));
    expect(markup).not.toContain("Reconnecting");
    expect(() => h.find("Pressable", (props) => typeof props["onPress"] === "function")).toThrow();
  });

  it("falls back to a generic environment label when none is provided", () => {
    const markup = render(baseProps({ connectionState: "offline", environmentLabel: null }));
    expect(markup).toContain("You are offline");
  });

  it("invokes the reconnect callback from the status pill", () => {
    let reconnected = 0;
    render(
      baseProps({ connectionState: "offline", onReconnectEnvironment: () => (reconnected += 1) }),
    );
    const pill = h.find("Pressable", (props) => typeof props["onPress"] === "function");
    (pill["onPress"] as () => void)();
    expect(reconnected).toBe(1);
  });
});

describe("ThreadComposer expanded rendering", () => {
  it("renders the toolbar, model trigger, and options trigger when focused", () => {
    seedExpanded();
    const markup = render(baseProps());
    expect(markup).toContain("data-toolbar-row");
    const model = h.find(
      "ComposerToolbarTrigger",
      (props) => props["accessibilityLabel"] === "Model",
    );
    expect(model["label"]).toBe("GPT-5");
    expect(h.filter("ComposerToolbarTrigger")).toHaveLength(2);
  });

  it("labels the expanded send action Queue when messages are queued", () => {
    seedExpanded();
    render(baseProps({ queueCount: 2 }));
    const send = h.find("ComposerToolbarButton", (props) => props["variant"] === "primary");
    expect(send["accessibilityLabel"]).toBe("Queue");
    expect(send["disabled"]).toBe(true);
  });

  it("shows the expanded stop action and attachment strip while running with attachments", () => {
    seedExpanded();
    render(
      baseProps({
        selectedThread: makeThreadShell({ sessionStatus: "starting" }),
        draftAttachments: attachments("a"),
      }),
    );
    expect(
      h.filter("ComposerToolbarButton", (props) => props["icon"] === "stop.fill"),
    ).toHaveLength(1);
    expect(h.filter("ComposerAttachmentStrip")).toHaveLength(1);
  });

  it("renders a queued-messages hint (plural)", () => {
    const markup = render(baseProps({ queueCount: 3 }));
    expect(markup).toContain("3 queued messages will send");
  });

  it("renders a queued-messages hint (singular)", () => {
    const markup = render(baseProps({ queueCount: 1 }));
    expect(markup).toContain("1 queued message will send");
  });
});

describe("ThreadComposer surface variants", () => {
  it("uses the opaque View surface when liquid glass is unsupported", () => {
    h.liquidGlassSupported = false;
    const markup = render(baseProps());
    expect(markup).not.toContain("data-liquid-glass");
  });

  it("uses the LiquidGlassView surface when supported (dark mode)", () => {
    h.liquidGlassSupported = true;
    h.colorScheme = "dark";
    const markup = render(baseProps());
    expect(markup).toContain("data-liquid-glass");
  });
});

describe("ThreadComposer trigger menus", () => {
  it("lists built-in slash commands filtered by the query", () => {
    render(baseProps({ draftMessage: "/mod" }));
    const popover = h.find("ComposerCommandPopover");
    const items = popover["items"] as Array<{ id: string; label: string }>;
    expect(items.map((item) => item.label)).toContain("/model");
    expect(items.some((item) => item.label === "/plan")).toBe(false);
    expect(popover["triggerKind"]).toBe("slash-command");
  });

  it("includes provider slash commands alongside the built-ins", () => {
    render(baseProps({ draftMessage: "/" }));
    const popover = h.find("ComposerCommandPopover");
    const items = popover["items"] as Array<{ id: string; type: string; label: string }>;
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["/model", "/plan", "/default", "/review"]),
    );
    expect(items.some((item) => item.type === "provider-slash-command")).toBe(true);
  });

  it("lists enabled skills for a bare skill trigger", () => {
    render(baseProps({ draftMessage: "$" }));
    const popover = h.find("ComposerCommandPopover");
    const items = popover["items"] as Array<{ id: string; label: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Web Search");
  });

  it("ranks skills against a non-empty skill query", () => {
    render(baseProps({ draftMessage: "$web" }));
    const popover = h.find("ComposerCommandPopover");
    const items = popover["items"] as Array<{ id: string; label: string }>;
    expect(items.map((item) => item.label)).toEqual(["Web Search"]);
  });

  it("lists path-search results for a path trigger", () => {
    h.pathSearch = {
      entries: [
        { path: "src/index.ts", kind: "file" },
        { path: "README.md", kind: "file" },
      ],
      isPending: true,
    };
    render(baseProps({ draftMessage: "@src" }));
    const popover = h.find("ComposerCommandPopover");
    const items = popover["items"] as Array<{ id: string; label: string; description: string }>;
    expect(items.map((item) => item.label)).toEqual(["index.ts", "README.md"]);
    expect(items[0]!.description).toBe("src");
    expect(popover["isLoading"]).toBe(true);
  });

  it("omits the popover when the trigger has no matching items", () => {
    const markup = render(
      baseProps({ draftMessage: "@nothing", serverConfig: makeServerConfig() }),
    );
    expect(markup).not.toContain("data-command-popover");
  });
});

describe("ThreadComposer command selection", () => {
  function popoverSelect(draftMessage: string): {
    readonly onSelect: (item: unknown) => void;
    readonly changes: string[];
    readonly interactions: string[];
  } {
    const changes: string[] = [];
    const interactions: string[] = [];
    render(
      baseProps({
        draftMessage,
        onChangeDraftMessage: (value) => changes.push(value),
        onUpdateInteractionMode: (mode) => interactions.push(mode),
      }),
    );
    const popover = h.find("ComposerCommandPopover");
    return { onSelect: popover["onSelect"] as (item: unknown) => void, changes, interactions };
  }

  it("switches interaction mode and clears the text for /plan", () => {
    const { onSelect, changes, interactions } = popoverSelect("/plan");
    onSelect({ type: "slash-command", command: "plan" });
    expect(interactions).toEqual(["plan"]);
    expect(changes).toEqual([""]);
  });

  it("inserts a provider slash command replacement", () => {
    const { onSelect, changes } = popoverSelect("/rev");
    onSelect({ type: "provider-slash-command", command: { name: "review" } });
    expect(changes).toEqual(["/review "]);
  });

  it("inserts a skill mention replacement", () => {
    const { onSelect, changes } = popoverSelect("$web");
    onSelect({ type: "skill", skill: { name: "web-search" } });
    expect(changes).toEqual(["$web-search "]);
  });

  it("inserts a file-link replacement for a path selection", () => {
    h.pathSearch = { entries: [{ path: "src/index.ts", kind: "file" }], isPending: false };
    const { onSelect, changes } = popoverSelect("@src");
    onSelect({ type: "path", path: "src/index.ts" });
    expect(changes[0]).toContain("src/index.ts");
  });

  it("inserts a /model built-in replacement", () => {
    const { onSelect, changes } = popoverSelect("/mod");
    onSelect({ type: "slash-command", command: "model" });
    expect(changes).toEqual(["/model "]);
  });
});

describe("ThreadComposer menu handlers", () => {
  function menus(overrides: Partial<ThreadComposerProps> = {}) {
    seedExpanded();
    const modelSelections: ModelSelection[] = [];
    const runtimeModes: RuntimeMode[] = [];
    const interactionModes: ProviderInteractionMode[] = [];
    render(
      baseProps({
        onUpdateModelSelection: (value) => modelSelections.push(value),
        onUpdateRuntimeMode: (value) => runtimeModes.push(value),
        onUpdateInteractionMode: (value) => interactionModes.push(value),
        ...overrides,
      }),
    );
    const modelMenu = h.find(
      "ControlPillMenu",
      (props) =>
        Array.isArray(props["actions"]) &&
        (props["actions"] as Array<{ id: string }>).some((action) =>
          action.id.startsWith("provider:"),
        ),
    );
    const optionsMenu = h.find(
      "ControlPillMenu",
      (props) =>
        Array.isArray(props["actions"]) &&
        (props["actions"] as Array<{ id: string }>).some(
          (action) => action.id === "options-runtime",
        ),
    );
    return { modelMenu, optionsMenu, modelSelections, runtimeModes, interactionModes };
  }

  it("dispatches a model change from the model menu", () => {
    const { modelMenu, modelSelections } = menus();
    const onPressAction = modelMenu["onPressAction"] as (event: {
      nativeEvent: { event: string };
    }) => void;
    onPressAction({ nativeEvent: { event: "model:codex:gpt-5-mini" } });
    expect(modelSelections).toHaveLength(1);
    expect(modelSelections[0]!.model).toBe("gpt-5-mini");
  });

  it("ignores non-model events on the model menu", () => {
    const { modelMenu, modelSelections } = menus();
    const onPressAction = modelMenu["onPressAction"] as (event: {
      nativeEvent: { event: string };
    }) => void;
    onPressAction({ nativeEvent: { event: "noise" } });
    onPressAction({ nativeEvent: { event: "model:unknown-key" } });
    expect(modelSelections).toEqual([]);
  });

  it("dispatches runtime-mode changes from the options menu", () => {
    const { optionsMenu, runtimeModes } = menus();
    const onPressAction = optionsMenu["onPressAction"] as (event: {
      nativeEvent: { event: string };
    }) => void;
    onPressAction({ nativeEvent: { event: "options:runtime:approval-required" } });
    expect(runtimeModes).toEqual(["approval-required"]);
  });

  it("dispatches interaction-mode changes from the options menu", () => {
    const { optionsMenu, interactionModes } = menus();
    const onPressAction = optionsMenu["onPressAction"] as (event: {
      nativeEvent: { event: string };
    }) => void;
    onPressAction({ nativeEvent: { event: "options:interaction:plan" } });
    expect(interactionModes).toEqual(["plan"]);
  });

  it("reflects the current runtime and interaction modes in the options menu subtitles", () => {
    const { optionsMenu } = menus({
      selectedThread: makeThreadShell({
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
      }),
    });
    const actions = optionsMenu["actions"] as Array<{ id: string; subtitle?: string }>;
    expect(actions.find((action) => action.id === "options-runtime")?.subtitle).toBe(
      "Auto-accept edits",
    );
    expect(actions.find((action) => action.id === "options-interaction")?.subtitle).toBe("Plan");
  });

  it("labels approval-required runtime mode", () => {
    const { optionsMenu } = menus({
      selectedThread: makeThreadShell({ runtimeMode: "approval-required" }),
    });
    const actions = optionsMenu["actions"] as Array<{ id: string; subtitle?: string }>;
    expect(actions.find((action) => action.id === "options-runtime")?.subtitle).toBe(
      "Approve actions",
    );
  });
});

describe("ThreadComposer editor callbacks", () => {
  function editorProps(overrides: Partial<ThreadComposerProps> = {}) {
    const expandedChanges: boolean[] = [];
    const pasted: ReadonlyArray<string>[] = [];
    render(
      baseProps({
        onExpandedChange: (value) => expandedChanges.push(value),
        onNativePasteImages: (uris) => {
          pasted.push(uris);
          return Promise.resolve();
        },
        ...overrides,
      }),
    );
    return { editor: h.find("ComposerEditor"), expandedChanges, pasted };
  }

  it("notifies expansion changes on focus and blur", () => {
    const { editor, expandedChanges } = editorProps();
    (editor["onFocus"] as () => void)();
    (editor["onBlur"] as () => void)();
    expect(expandedChanges).toEqual([true, false]);
    const focusUpdates = h.setStateCalls.filter(
      (call) => call.applied === true || call.applied === false,
    );
    expect(focusUpdates.length).toBeGreaterThanOrEqual(2);
  });

  it("records selection changes and forwards native paste", () => {
    const { editor, pasted } = editorProps();
    (editor["onSelectionChange"] as (selection: { start: number; end: number }) => void)({
      start: 1,
      end: 3,
    });
    expect(h.setStateCalls.some((call) => (call.applied as { end?: number })?.end === 3)).toBe(
      true,
    );
    (editor["onPasteImages"] as (uris: ReadonlyArray<string>) => void)(["u1", "u2"]);
    expect(pasted).toEqual([["u1", "u2"]]);
  });

  it("clamps the composer selection when the draft shrinks (effect)", () => {
    render(baseProps({ draftMessage: "hi" }));
    h.runEffects();
    const clamped = h.setStateCalls.filter(
      (call) =>
        typeof call.next === "function" &&
        (call.applied as { start?: number })?.start !== undefined,
    );
    expect(clamped.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ThreadComposer image preview", () => {
  it("opens and closes the image viewer via the attachment strip", () => {
    vi.stubGlobal("setTimeout", ((callback: () => void) => {
      callback();
      return 0;
    }) as unknown as typeof setTimeout);
    seedExpanded();
    render(baseProps({ draftAttachments: attachments("a") }));
    const strip = h.find("ComposerAttachmentStrip");
    (strip["onPressImage"] as (uri: string) => void)("uri-a");
    const previewUpdate = h.setStateCalls.find((call) => call.applied === "uri-a");
    expect(previewUpdate).toBeDefined();

    const viewer = h.find("ImageViewing");
    (viewer["onRequestClose"] as () => void)();
    const closed = h.setStateCalls.find((call) => call.applied === null);
    expect(closed).toBeDefined();
  });

  it("opens the viewer from a collapsed attachment thumbnail", () => {
    const markup = render(baseProps({ draftAttachments: attachments("a") }));
    expect(markup).toContain("data-image");
    const thumb = h.find("Pressable", (props) => typeof props["onPress"] === "function");
    (thumb["onPress"] as () => void)();
    expect(h.setStateCalls.some((call) => call.applied === "uri-a")).toBe(true);
  });
});

describe("ThreadComposer send / image actions", () => {
  it("invokes onSendMessage from the collapsed send control", () => {
    let sent = 0;
    render(
      baseProps({
        draftMessage: "ship it",
        onSendMessage: () => {
          sent += 1;
          return Promise.resolve(null);
        },
      }),
    );
    const send = h.find("ControlPill", (props) => props["icon"] === "arrow.up");
    (send["onPress"] as () => void)();
    expect(sent).toBe(1);
  });

  it("invokes onPickDraftImages from the expanded add button", () => {
    let picked = 0;
    seedExpanded();
    render(baseProps({ onPickDraftImages: () => ((picked += 1), Promise.resolve()) }));
    const add = h.find("ComposerToolbarButton", (props) => props["icon"] === "plus");
    (add["onPress"] as () => void)();
    expect(picked).toBe(1);
  });

  it("invokes onStopThread from the collapsed stop control", () => {
    let stopped = 0;
    render(
      baseProps({
        selectedThread: makeThreadShell({ sessionStatus: "running" }),
        onStopThread: () => (stopped += 1),
      }),
    );
    const stop = h.find("ControlPill", (props) => props["icon"] === "stop.fill");
    (stop["onPress"] as () => void)();
    expect(stopped).toBe(1);
  });
});
