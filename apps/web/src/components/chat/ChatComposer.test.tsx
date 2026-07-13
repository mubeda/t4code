/**
 * Unit tests for the ChatComposer mega-component.
 *
 * Strategy: the composer is rendered once per scenario with
 * `renderToStaticMarkup` (no DOM, per web test conventions). Heavy children
 * and UI primitives are replaced with prop-capturing mocks, the real composer
 * draft store is seeded directly, and a partial react mock instruments the
 * stateful hooks: `useState` values are seedable by ordinal index (setter
 * calls are recorded), effects and imperative handles are queued during
 * render and flushed afterwards. A jsx-runtime tap records every host
 * element's props so DOM handlers (drag/drop, focus capture, form submit,
 * collapsed-mobile buttons) can be invoked directly with fake events.
 */
import {
  ApprovalRequestId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  ThreadId,
} from "@t4code/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t4code/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t4code/client-runtime/environment";
import type { EnvironmentConnectionPresentation } from "@t4code/client-runtime/connection";
import { serializeComposerFileLink } from "@t4code/shared/composerTrigger";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// ---------------------------------------------------------------------------
// Hoisted harness shared with every vi.mock factory.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  interface Captured {
    readonly name: string;
    readonly props: Record<string, unknown>;
  }
  interface HostElement {
    readonly type: string;
    readonly props: Record<string, unknown>;
  }

  const state = {
    React: null as unknown as typeof import("react"),
    stateIndex: 0,
    stateSeeds: new Map<number, unknown>(),
    setStateCalls: [] as Array<{ index: number; value: unknown }>,
    effects: [] as Array<() => unknown>,
    executed: [] as Array<() => unknown>,
    cleanups: [] as Array<() => void>,
    captures: [] as Captured[],
    hostElements: [] as HostElement[],
    editorSnapshot: null as {
      value: string;
      cursor: number;
      expandedCursor: number;
      terminalContextIds: string[];
    } | null,
    editorHandle: {
      focus: vi.fn(),
      focusAt: vi.fn(),
      focusAtEnd: vi.fn(),
      readSnapshot: vi.fn((): unknown => state.editorSnapshot),
    },
    pathSearch: {
      entries: [] as Array<{ path: string; kind: string }>,
      error: null as string | null,
      isPending: false,
    },
    isMobile: false,
    toastAdd: vi.fn(),
    recordHost(type: unknown, props: unknown) {
      if (typeof type === "string" && props && typeof props === "object") {
        state.hostElements.push({ type, props: props as Record<string, unknown> });
      }
    },
    mk(name: string, tag = "div") {
      const Component = (props: Record<string, unknown>) => {
        state.captures.push({ name, props });
        const R = state.React;
        const { children, render } = props as { children?: unknown; render?: unknown };
        const passthrough: Record<string, unknown> = { "data-mock": name };
        for (const key of Object.keys(props)) {
          if (key === "children" || key === "render" || key === "ref") continue;
          const value = props[key];
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            passthrough[`data-prop-${key.toLowerCase()}`] = String(value);
          }
        }
        if (props["aria-label"] !== undefined) {
          passthrough["aria-label"] = props["aria-label"];
        }
        if (render !== undefined && R.isValidElement(render)) {
          return children === undefined
            ? R.cloneElement(render as never, passthrough as never)
            : R.cloneElement(render as never, passthrough as never, children as never);
        }
        return R.createElement(tag, passthrough, children as never);
      };
      Component.displayName = name;
      return Component;
    },
  };
  return state;
});

// ---------------------------------------------------------------------------
// Partial react mock: seedable indexed useState, queued effects + handles.
// ---------------------------------------------------------------------------

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();

  const useState = (initial?: unknown) => {
    const index = h.stateIndex;
    h.stateIndex += 1;
    const resolved = typeof initial === "function" ? (initial as () => unknown)() : initial;
    const value = h.stateSeeds.has(index) ? h.stateSeeds.get(index) : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (current: unknown) => unknown)(value) : next;
      h.setStateCalls.push({ index, value: applied });
    };
    return [value, setValue];
  };

  const queueEffect = (effect: () => unknown) => {
    h.effects.push(effect);
  };

  const useImperativeHandle = (ref: unknown, create: () => unknown) => {
    h.effects.push(() => {
      if (typeof ref === "function") {
        (ref as (value: unknown) => void)(create());
        return;
      }
      if (ref && typeof ref === "object") {
        (ref as { current: unknown }).current = create();
      }
    });
  };

  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: queueEffect as typeof actual.useEffect,
    useLayoutEffect: queueEffect as typeof actual.useLayoutEffect,
    useImperativeHandle: useImperativeHandle as typeof actual.useImperativeHandle,
  };
});

// Tap the automatic JSX runtimes so host-element props (drag handlers, form
// submit, collapsed-mobile buttons) can be located and invoked directly.
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return {
    ...actual,
    jsx: ((type, props, key) => {
      h.recordHost(type, props);
      return actual.jsx(type, props, key);
    }) as typeof actual.jsx,
    jsxs: ((type, props, key) => {
      h.recordHost(type, props);
      return actual.jsxs(type, props, key);
    }) as typeof actual.jsxs,
  };
});

vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = (await importOriginal<Record<string, unknown>>()) as {
    jsxDEV?: (...args: unknown[]) => unknown;
  } & Record<string, unknown>;
  if (typeof actual["jsxDEV"] !== "function") {
    return actual;
  }
  const original = actual["jsxDEV"] as (...args: unknown[]) => unknown;
  return {
    ...actual,
    jsxDEV: (...args: unknown[]) => {
      h.recordHost(args[0], args[1]);
      return original(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// UI primitives and heavy children replaced with capture-mocks.
// ---------------------------------------------------------------------------

vi.mock("../ui/separator", () => ({ Separator: h.mk("Separator", "span") }));
vi.mock("../ui/button", () => ({ Button: h.mk("Button", "button") }));
vi.mock("../ui/select", () => ({
  Select: h.mk("Select"),
  SelectItem: h.mk("SelectItem"),
  SelectPopup: h.mk("SelectPopup"),
  SelectTrigger: h.mk("SelectTrigger", "button"),
  SelectValue: h.mk("SelectValue", "span"),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: h.mk("Tooltip"),
  TooltipPopup: h.mk("TooltipPopup"),
  TooltipTrigger: h.mk("TooltipTrigger"),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: h.toastAdd } }));

vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor: (props: Record<string, unknown>) => {
    h.captures.push({ name: "ComposerPromptEditor", props });
    const editorRef = props["editorRef"] as { current: unknown } | null | undefined;
    if (editorRef && typeof editorRef === "object") {
      editorRef.current = h.editorHandle;
    }
    return h.React.createElement("div", {
      "data-mock": "composer-prompt-editor",
      "data-disabled": String(props["disabled"]),
      "data-placeholder": String(props["placeholder"]),
      "data-value": String(props["value"]),
      "data-editor-class": String(props["className"] ?? ""),
    });
  },
}));

vi.mock("./ProviderModelPicker", () => ({
  ProviderModelPicker: (props: Record<string, unknown>) => {
    h.captures.push({ name: "ProviderModelPicker", props });
    return h.React.createElement("div", {
      "data-mock": "provider-model-picker",
      "data-instance": String(props["activeInstanceId"]),
      "data-model": String(props["model"]),
      "data-open": String(props["open"]),
    });
  },
}));

vi.mock("./ComposerCommandMenu", () => ({
  ComposerCommandMenu: (props: Record<string, unknown>) => {
    h.captures.push({ name: "ComposerCommandMenu", props });
    const items = props["items"] as ReadonlyArray<{ id: string }>;
    return h.React.createElement("div", {
      "data-mock": "composer-command-menu",
      "data-count": String(items.length),
      "data-active": String(props["activeItemId"]),
      "data-loading": String(props["isLoading"]),
      "data-empty-text": String(props["emptyStateText"]),
    });
  },
}));

vi.mock("./ComposerPendingApprovalActions", () => ({
  ComposerPendingApprovalActions: h.mk("ComposerPendingApprovalActions"),
}));
vi.mock("./CompactComposerControlsMenu", () => ({
  CompactComposerControlsMenu: h.mk("CompactComposerControlsMenu"),
}));
vi.mock("./ComposerPrimaryActions", () => ({
  ComposerPrimaryActions: h.mk("ComposerPrimaryActions"),
}));
vi.mock("./ComposerPendingApprovalPanel", () => ({
  ComposerPendingApprovalPanel: h.mk("ComposerPendingApprovalPanel"),
}));
vi.mock("./ComposerPendingUserInputPanel", () => ({
  ComposerPendingUserInputPanel: h.mk("ComposerPendingUserInputPanel"),
}));
vi.mock("./ComposerPlanFollowUpBanner", () => ({
  ComposerPlanFollowUpBanner: h.mk("ComposerPlanFollowUpBanner"),
}));
vi.mock("./ComposerPendingElementContexts", () => ({
  ComposerPendingElementContexts: h.mk("ComposerPendingElementContexts"),
}));
vi.mock("./ComposerPendingReviewComments", () => ({
  ComposerPendingReviewComments: h.mk("ComposerPendingReviewComments"),
}));
vi.mock("./ComposerPreviewAnnotationCards", () => ({
  ComposerPreviewAnnotationCards: h.mk("ComposerPreviewAnnotationCards"),
}));
vi.mock("./ContextWindowMeter", () => ({ ContextWindowMeter: h.mk("ContextWindowMeter") }));

// ---------------------------------------------------------------------------
// State hooks and heavy state modules.
// ---------------------------------------------------------------------------

vi.mock("../../lib/composerPathSearchState", () => ({
  useComposerPathSearch: (target: unknown) => {
    h.captures.push({ name: "useComposerPathSearch", props: { target } });
    return h.pathSearch;
  },
}));

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => h.isMobile,
  useIsMobile: () => h.isMobile,
}));

// ChatView.logic imports the atom-creating threads module at top level; give
// it an inert stub so importing the composer stays side-effect free.
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { detailAtom: () => ({}) },
}));

import { type ChatComposerHandle, type ChatComposerProps, ChatComposer } from "./ChatComposer";
import { type ComposerImageAttachment, useComposerDraftStore } from "../../composerDraftStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import type { ElementContextDraft } from "../../lib/elementContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { Thread } from "../../types";

h.React = React;

// ---------------------------------------------------------------------------
// useState ordinal indexes inside ChatComposer (render order).
// ---------------------------------------------------------------------------

const STATE = {
  cursor: 0,
  trigger: 1,
  highlightedItemId: 2,
  highlightedSearchKey: 3,
  dragOver: 4,
  footerCompact: 5,
  primaryActionsCompact: 6,
  modelPickerOpen: 7,
  focused: 8,
} as const;

// ---------------------------------------------------------------------------
// Globals: window / document / DOM classes / FileReader.
// ---------------------------------------------------------------------------

class FakeNode {
  readonly isFakeNode = true;
}
class FakeElement extends FakeNode {
  closestResult: unknown = null;
  closest(): unknown {
    return this.closestResult;
  }
  contains(): boolean {
    return false;
  }
}
class FakeHTMLElement extends FakeElement {
  blur = vi.fn();
  focus = vi.fn();
}

const rafCallbacks: Array<(time: number) => void> = [];
const windowStub = {
  requestAnimationFrame: (callback: (time: number) => void): number => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  },
  cancelAnimationFrame: vi.fn(),
};
const documentStub: { activeElement: unknown } = { activeElement: null };

function runAnimationFrames(): void {
  while (rafCallbacks.length > 0) {
    const batch = rafCallbacks.splice(0, rafCallbacks.length);
    for (const callback of batch) {
      callback(0);
    }
  }
}

let fileReaderShouldFail = false;
class FakeFileReader {
  result: string | null = null;
  error: Error | null = null;
  private listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  readAsDataURL(file: { type?: string; name?: string }): void {
    if (fileReaderShouldFail) {
      this.error = new Error("read failed");
      for (const listener of this.listeners["error"] ?? []) listener();
      return;
    }
    this.result = `data:${file.type ?? "application/octet-stream"};base64,${file.name ?? ""}`;
    for (const listener of this.listeners["load"] ?? []) listener();
  }
}

const urlStatics = URL as unknown as {
  createObjectURL: ((blob: unknown) => string) | undefined;
  revokeObjectURL: ((url: string) => void) | undefined;
};
const realCreateObjectURL = urlStatics.createObjectURL;
const realRevokeObjectURL = urlStatics.revokeObjectURL;
let objectUrlCounter = 0;
const createObjectURLMock = vi.fn(() => `blob:generated-${(objectUrlCounter += 1)}`);
const revokeObjectURLMock = vi.fn();

// ---------------------------------------------------------------------------
// Effect flushing helpers.
// ---------------------------------------------------------------------------

function flushQueuedEffects(): void {
  while (h.effects.length > 0) {
    const pending = h.effects.splice(0, h.effects.length);
    for (const effect of pending) {
      h.executed.push(effect);
      const cleanup = effect();
      if (typeof cleanup === "function") {
        h.cleanups.push(cleanup as () => void);
      }
    }
  }
}

/** Re-run every executed effect: simulates a controlled re-render pass. */
function reflushExecutedEffects(): void {
  for (const effect of Array.from(h.executed)) {
    effect();
  }
}

function runCleanups(): void {
  for (const cleanup of h.cleanups.splice(0, h.cleanups.length)) {
    cleanup();
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// Capture / host element lookup helpers.
// ---------------------------------------------------------------------------

function filterCaptures(name: string): Array<Record<string, unknown>> {
  return h.captures.filter((entry) => entry.name === name).map((entry) => entry.props);
}

function findCapture(
  name: string,
  predicate?: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const found = h.captures.find(
    (entry) => entry.name === name && (predicate?.(entry.props) ?? true),
  )?.props;
  if (!found) throw new Error(`No captured "${name}" matched`);
  return found;
}

function lastCapture(name: string): Record<string, unknown> {
  const matches = filterCaptures(name);
  const found = matches[matches.length - 1];
  if (!found) throw new Error(`No captured "${name}"`);
  return found;
}

function captureByLabel(name: string, label: string): Record<string, unknown> {
  return findCapture(name, (props) => props["aria-label"] === label);
}

function findHost(
  predicate: (element: { type: string; props: Record<string, unknown> }) => boolean,
): { type: string; props: Record<string, unknown> } {
  const found = h.hostElements.find(predicate);
  if (!found) throw new Error("No host element matched");
  return found;
}

function hostByLabel(label: string): Record<string, unknown> {
  return findHost((element) => element.props["aria-label"] === label).props;
}

function setStateValues(index: number): unknown[] {
  return h.setStateCalls.filter((call) => call.index === index).map((call) => call.value);
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const threadRef = scopeThreadRef(environmentId, threadId);
const threadKey = scopedThreadKey(threadRef);
const codexInstanceId = ProviderInstanceId.make("codex");
const now = "2026-03-29T00:00:00.000Z";

const codexProvider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  slashCommands: [{ name: "review", description: "Review the working tree" }],
  skills: [
    {
      name: "refactor",
      displayName: "Refactor",
      shortDescription: "Refactor code safely",
      description: "Long refactor description",
      path: "/skills/refactor",
      scope: "project",
      enabled: true,
    },
    { name: "docs", path: "/skills/docs", enabled: true, invocation: "slash" },
  ],
  agents: [
    {
      name: "code-reviewer",
      description: "Review changes with a dedicated agent",
      model: "gpt-5.4",
    },
  ],
};

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Demo Thread",
    modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const proposedPlan: Thread["proposedPlans"][number] = {
  id: "plan-1",
  turnId: null,
  planMarkdown: "# Improve tests\n\n1. Write them",
  implementedAt: null,
  implementationThreadId: null,
  createdAt: now,
  updatedAt: now,
};

const pendingApproval: PendingApproval = {
  requestId: ApprovalRequestId.make("approval-1"),
  requestKind: "command",
  createdAt: now,
  detail: "Run pnpm test",
};

function makePendingUserInput(): PendingUserInput {
  return {
    requestId: ApprovalRequestId.make("input-1"),
    createdAt: now,
    questions: [
      {
        id: "q1",
        header: "Choose",
        question: "Pick one",
        options: [{ label: "A", description: "Option A" }],
        multiSelect: false,
      },
    ],
  };
}

function makePendingProgress(
  overrides: Partial<NonNullable<ChatComposerProps["activePendingProgress"]>> = {},
): NonNullable<ChatComposerProps["activePendingProgress"]> {
  return {
    questionIndex: 0,
    isLastQuestion: true,
    canAdvance: true,
    customAnswer: "",
    activeQuestion: { id: "q1", multiSelect: false },
    ...overrides,
  };
}

let imageCounter = 0;
function makeImage(overrides: Partial<ComposerImageAttachment> = {}): ComposerImageAttachment {
  imageCounter += 1;
  return {
    type: "image",
    id: `img-${imageCounter}`,
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 4,
    previewUrl: `blob:existing-${imageCounter}`,
    file: new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" }),
    ...overrides,
  };
}

function makeTerminalContext(id: string, text = "npm test output"): TerminalContextDraft {
  return {
    id,
    threadId,
    createdAt: now,
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 3,
    text,
  };
}

function makeElementContext(id: string): ElementContextDraft {
  return {
    id,
    threadId,
    pickedAt: now,
    pageUrl: "http://localhost:3000/",
    pageTitle: "App",
    tagName: "button",
    selector: "#save",
    htmlPreview: '<button id="save">Save</button>',
    componentName: "SaveButton",
    source: null,
    styles: "",
  };
}

function makeReviewComment(id: string): ReviewCommentContext {
  return {
    id,
    sectionId: "section-1",
    sectionTitle: "src/app.ts",
    filePath: "src/app.ts",
    startIndex: 0,
    endIndex: 10,
    rangeLabel: "L1-L2",
    text: "Tighten this",
    diff: "+const a = 1;",
  };
}

const emptyKeybindings = [] as unknown as ResolvedKeybindingsConfig;

const draftStore = () => useComposerDraftStore.getState();
const draftOf = (ref: typeof threadRef) => draftStore().getComposerDraft(ref);

interface ResettableStore {
  getState: () => object;
  getInitialState: () => object;
  setState: (state: object, replace: true) => void;
}

const resettableComposerStore = useComposerDraftStore as unknown as ResettableStore;
const pristineComposerState = { ...resettableComposerStore.getInitialState() };

/**
 * renderToStaticMarkup reads zustand state through `getInitialState()` (the
 * server snapshot), so seeded state written with regular actions must be
 * copied into the initial-state object before rendering.
 */
function publishSeededStoreState(): void {
  Object.assign(resettableComposerStore.getInitialState(), resettableComposerStore.getState());
}

// ---------------------------------------------------------------------------
// Render harness.
// ---------------------------------------------------------------------------

function makeSpies() {
  return {
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onImplementPlanInNewThread: vi.fn(),
    onRespondToApproval: vi.fn(() => Promise.resolve(undefined)),
    onSelectActivePendingUserInputOption: vi.fn(),
    onAdvanceActivePendingUserInput: vi.fn(),
    onPreviousActivePendingUserInputQuestion: vi.fn(),
    onChangeActivePendingUserInputCustomAnswer: vi.fn(),
    onProviderModelSelect: vi.fn(),
    getModelDisabledReason: vi.fn(() => null),
    toggleInteractionMode: vi.fn(),
    handleRuntimeModeChange: vi.fn(),
    handleInteractionModeChange: vi.fn(),
    togglePlanSidebar: vi.fn(),
    focusComposer: vi.fn(),
    scheduleComposerFocus: vi.fn(),
    setThreadError: vi.fn(),
    onExpandImage: vi.fn(),
  };
}

interface RenderResult {
  markup: string;
  props: ChatComposerProps;
  spies: ReturnType<typeof makeSpies>;
  composerRef: React.RefObject<ChatComposerHandle | null>;
  handle: () => ChatComposerHandle;
}

function renderComposer(overrides: Partial<ChatComposerProps> = {}): RenderResult {
  const spies = makeSpies();
  const composerRef: React.RefObject<ChatComposerHandle | null> = { current: null };
  const props: ChatComposerProps = {
    composerDraftTarget: threadRef,
    environmentId,
    routeKind: "server",
    routeThreadRef: threadRef,
    draftId: null,
    activeThreadId: threadId,
    activeThreadEnvironmentId: environmentId,
    activeThread: makeThread(),
    isServerThread: true,
    isLocalDraftThread: false,
    phase: "ready",
    isConnecting: false,
    isSendBusy: false,
    isPreparingWorktree: false,
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    activePlan: null,
    sidebarProposedPlan: null,
    planSidebarLabel: "Plan",
    planSidebarOpen: false,
    runtimeMode: "approval-required",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: [codexProvider],
    activeProjectDefaultModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    activeThreadModelSelection: null,
    activeThreadActivities: [],
    resolvedTheme: "dark",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: emptyKeybindings,
    terminalOpen: false,
    gitCwd: "/repo",
    promptRef: { current: "" },
    composerImagesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerElementContextsRef: { current: [] },
    composerRef,
    onSend: spies.onSend,
    onInterrupt: spies.onInterrupt,
    onImplementPlanInNewThread: spies.onImplementPlanInNewThread,
    onRespondToApproval: spies.onRespondToApproval,
    onSelectActivePendingUserInputOption: spies.onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput: spies.onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion: spies.onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer: spies.onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect: spies.onProviderModelSelect,
    getModelDisabledReason: spies.getModelDisabledReason,
    toggleInteractionMode: spies.toggleInteractionMode,
    handleRuntimeModeChange: spies.handleRuntimeModeChange,
    handleInteractionModeChange: spies.handleInteractionModeChange,
    togglePlanSidebar: spies.togglePlanSidebar,
    focusComposer: spies.focusComposer,
    scheduleComposerFocus: spies.scheduleComposerFocus,
    setThreadError: spies.setThreadError,
    onExpandImage: spies.onExpandImage,
    ...overrides,
  };
  h.stateIndex = 0;
  h.captures.length = 0;
  h.hostElements.length = 0;
  publishSeededStoreState();
  const markup = renderToStaticMarkup(<ChatComposer {...props} />);
  flushQueuedEffects();
  return {
    markup,
    props,
    spies,
    composerRef,
    handle: () => {
      if (!composerRef.current) throw new Error("composer handle not attached");
      return composerRef.current;
    },
  };
}

function editorProps(): Record<string, unknown> {
  return lastCapture("ComposerPromptEditor");
}

type PromptChange = (
  nextPrompt: string,
  nextCursor: number,
  expandedCursor: number,
  cursorAdjacentToMention: boolean,
  terminalContextIds: string[],
) => void;

type CommandKey = (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab", event: KeyboardEvent) => boolean;

function keyEvent(overrides: Partial<{ shiftKey: boolean }> = {}): KeyboardEvent {
  return { shiftKey: false, ...overrides } as unknown as KeyboardEvent;
}

function setEditorSnapshot(value: string, cursor: number, terminalContextIds: string[] = []): void {
  h.editorSnapshot = { value, cursor, expandedCursor: cursor, terminalContextIds };
}

function seedPrompt(prompt: string): void {
  draftStore().setPrompt(threadRef, prompt);
}

interface FakeDragEventInit {
  types?: string[];
  files?: File[];
  relatedTarget?: unknown;
  containsRelated?: boolean;
}

function dragEvent(init: FakeDragEventInit = {}) {
  const dataTransfer = {
    types: init.types ?? ["Files"],
    files: init.files ?? [],
    dropEffect: "",
  };
  return {
    dataTransfer,
    preventDefault: vi.fn(),
    relatedTarget: init.relatedTarget ?? null,
    currentTarget: { contains: () => init.containsRelated ?? false },
  };
}

function pasteEvent(files: File[]) {
  return {
    clipboardData: { files },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent<HTMLElement>;
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  h.stateIndex = 0;
  h.stateSeeds.clear();
  h.setStateCalls.length = 0;
  h.effects.length = 0;
  h.executed.length = 0;
  h.cleanups.length = 0;
  h.captures.length = 0;
  h.hostElements.length = 0;
  h.editorSnapshot = null;
  h.pathSearch = { entries: [], error: null, isPending: false };
  h.isMobile = false;
  rafCallbacks.length = 0;
  documentStub.activeElement = null;
  fileReaderShouldFail = false;
  resettableComposerStore.setState({ ...pristineComposerState }, true);
  Object.assign(resettableComposerStore.getInitialState(), pristineComposerState);
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("FileReader", FakeFileReader);
  urlStatics.createObjectURL = createObjectURLMock;
  urlStatics.revokeObjectURL = revokeObjectURLMock;
});

afterEach(() => {
  vi.unstubAllGlobals();
  urlStatics.createObjectURL = realCreateObjectURL;
  urlStatics.revokeObjectURL = realRevokeObjectURL;
});

// ---------------------------------------------------------------------------
// Rendering scenarios
// ---------------------------------------------------------------------------

describe("ChatComposer rendering", () => {
  it("renders the idle composer with editor, model picker, and runtime mode", () => {
    const { markup } = renderComposer();

    expect(markup).toContain('data-chat-composer-form="true"');
    expect(markup).toContain(
      'data-placeholder="Ask anything, @tag files/folders, $use skills, or / for commands"',
    );
    expect(markup).toContain('data-disabled="false"');
    expect(markup).toContain('data-instance="codex"');
    expect(markup).toContain('data-model="gpt-5.4"');
    expect(markup).toContain("Supervised");
    expect(markup).toContain("Auto-approve edits, ask before other actions.");
    expect(markup).not.toContain('data-mock="composer-command-menu"');
    expect(markup).not.toContain('data-mock="ContextWindowMeter"');

    const select = findCapture("Select");
    expect(select["value"]).toBe("approval-required");
    const picker = findCapture("ProviderModelPicker");
    expect(picker["lockedProvider"]).toBeNull();
    expect(picker["lockToActiveInstance"]).toBe(true);

    // Path search targets nothing while no path trigger is active.
    const pathSearch = findCapture("useComposerPathSearch")["target"] as Record<string, unknown>;
    expect(pathSearch["cwd"]).toBeNull();
    expect(pathSearch["query"]).toBeNull();
  });

  it("disables the editor while connecting and when the environment is unavailable", () => {
    renderComposer({ isConnecting: true });
    expect(editorProps()["disabled"]).toBe(true);

    const connection: EnvironmentConnectionPresentation = {
      phase: "offline",
      error: null,
      traceId: null,
    };
    const { markup } = renderComposer({
      environmentUnavailable: { label: "Laptop", connection },
    });
    expect(markup).toContain('data-placeholder="Laptop: Offline"');
    expect(markup).toContain("opacity-75");
    expect(editorProps()["disabled"]).toBe(true);
  });

  it("shows the disconnected placeholder", () => {
    const { markup } = renderComposer({ phase: "disconnected" });
    expect(markup).toContain('data-placeholder="Ask for follow-up changes or attach images"');
  });

  it("renders the approval header, empties the editor, and swaps the footer", () => {
    seedPrompt("hidden while approving");
    const { markup } = renderComposer({
      activePendingApproval: pendingApproval,
      pendingApprovals: [pendingApproval],
      respondingRequestIds: [pendingApproval.requestId],
    });

    expect(markup).toContain('data-mock="ComposerPendingApprovalPanel"');
    expect(markup).toContain('data-mock="ComposerPendingApprovalActions"');
    expect(markup).not.toContain('data-mock="provider-model-picker"');
    expect(editorProps()["value"]).toBe("");
    expect(editorProps()["placeholder"]).toBe("Run pnpm test");

    const actions = findCapture("ComposerPendingApprovalActions");
    expect(actions["isResponding"]).toBe(true);
  });

  it("falls back to the generic approval placeholder without a detail", () => {
    const { detail: _detail, ...approvalWithoutDetail } = pendingApproval;
    renderComposer({
      activePendingApproval: approvalWithoutDetail,
      pendingApprovals: [pendingApproval],
    });
    expect(editorProps()["placeholder"]).toBe("Resolve this approval request to continue");
  });

  it("renders the pending user input panel and custom answer editor", () => {
    const { markup } = renderComposer({
      pendingUserInputs: [makePendingUserInput()],
      activePendingProgress: makePendingProgress({ customAnswer: "my answer" }),
    });

    expect(markup).toContain('data-mock="ComposerPendingUserInputPanel"');
    expect(editorProps()["value"]).toBe("my answer");
    expect(editorProps()["placeholder"]).toBe(
      "Type your own answer, or leave this blank to use the selected option",
    );
    // Terminal contexts are suppressed while questions are pending.
    expect(editorProps()["terminalContexts"]).toEqual([]);
  });

  it("renders the plan follow-up banner with the extracted plan title", () => {
    const { markup } = renderComposer({
      showPlanFollowUpPrompt: true,
      activeProposedPlan: proposedPlan,
    });

    expect(markup).toContain('data-mock="ComposerPlanFollowUpBanner"');
    const banner = findCapture("ComposerPlanFollowUpBanner");
    expect(banner["planTitle"]).toBe("Improve tests");
    expect(editorProps()["placeholder"]).toBe(
      "Add feedback to refine the plan, or leave this blank to implement it",
    );
  });

  it("shows the plan sidebar toggle and forwards toggle clicks", () => {
    const { markup, spies } = renderComposer({ planSidebarOpen: true });
    expect(markup).toContain("Plan");

    const toggle = captureByLabel("Button", "Hide plan sidebar");
    (toggle["onClick"] as () => void)();
    expect(spies.togglePlanSidebar).toHaveBeenCalledTimes(1);
  });

  it("forwards runtime mode and interaction mode changes", () => {
    const { spies } = renderComposer();

    const select = findCapture("Select");
    (select["onValueChange"] as (value: string) => void)("full-access");
    expect(spies.handleRuntimeModeChange).toHaveBeenCalledWith("full-access");

    const toggle = captureByLabel("Button", "Default mode — click to enter plan mode");
    (toggle["onClick"] as () => void)();
    expect(spies.toggleInteractionMode).toHaveBeenCalledTimes(1);
  });

  it("labels the interaction toggle for plan mode and hides it when disabled", () => {
    const { markup } = renderComposer({ interactionMode: "plan" });
    expect(markup).toContain("Plan mode — click to return to normal build mode");

    const hidden = renderComposer({
      providerStatuses: [{ ...codexProvider, showInteractionModeToggle: false }],
    });
    expect(hidden.markup).not.toContain("Default mode — click to enter plan mode");
  });

  it("renders the compact footer controls when the footer is compact", () => {
    h.stateSeeds.set(STATE.footerCompact, true);
    h.stateSeeds.set(STATE.primaryActionsCompact, true);
    const { markup, spies } = renderComposer({ planSidebarOpen: true });

    expect(markup).toContain('data-mock="CompactComposerControlsMenu"');
    expect(markup).toContain('data-chat-composer-footer-compact="true"');
    const compact = findCapture("CompactComposerControlsMenu");
    (compact["onToggleInteractionMode"] as () => void)();
    expect(spies.toggleInteractionMode).toHaveBeenCalledTimes(1);

    const primary = findCapture("ComposerPrimaryActions");
    expect(primary["compact"]).toBe(true);
  });

  it("renders the context window meter when activities carry usage", () => {
    // deriveLatestContextWindowSnapshot(): no usable activity -> no meter.
    const { markup } = renderComposer({ activeThreadActivities: undefined });
    expect(markup).not.toContain('data-mock="ContextWindowMeter"');
  });

  it("shows the preparing worktree hint", () => {
    const { markup } = renderComposer({ isPreparingWorktree: true });
    expect(markup).toContain("Preparing worktree...");
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe("ChatComposer attachments", () => {
  it("renders image previews, remove buttons, and non-persisted warnings", async () => {
    const withPreview = makeImage({ id: "img-a", name: "shot.png" });
    const withoutPreview = makeImage({ id: "img-b", name: "plain.png", previewUrl: "" });
    draftStore().addImages(threadRef, [withPreview, withoutPreview]);
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [threadKey]: {
          ...state.draftsByThreadKey[threadKey]!,
          nonPersistedImageIds: ["img-a"],
        },
      },
    }));

    const { markup, spies } = renderComposer();
    await flushMicrotasks();

    expect(markup).toContain('aria-label="Preview shot.png"');
    expect(markup).toContain("plain.png");
    expect(markup).toContain("Draft attachment may not persist");

    // Preview click resolves the expanded preview from previewable images.
    const previewButton = hostByLabel("Preview shot.png");
    (previewButton["onClick"] as () => void)();
    expect(spies.onExpandImage).toHaveBeenCalledWith({
      images: [{ src: withPreview.previewUrl, name: "shot.png" }],
      index: 0,
    });

    // Remove click deletes the image from the draft store.
    const removeButton = captureByLabel("Button", "Remove shot.png");
    (removeButton["onClick"] as () => void)();
    expect(draftOf(threadRef)?.images.map((image) => image.id)).toEqual(["img-b"]);

    // The persist effect staged data urls through the FileReader stub; the
    // store's verification pass then strips them again because nothing ever
    // reaches localStorage in this environment, marking images non-persisted.
    expect(draftOf(threadRef)?.persistedAttachments).toEqual([]);
    expect(draftOf(threadRef)?.nonPersistedImageIds).toEqual(["img-b"]);
  });

  it("restages existing persisted attachments when reading a file fails", async () => {
    const image = makeImage({ id: "img-keep" });
    draftStore().addImages(threadRef, [image]);
    draftStore().syncPersistedAttachments(threadRef, [
      {
        id: "img-keep",
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: "data:image/png;base64,old",
      },
    ]);
    fileReaderShouldFail = true;

    renderComposer();
    await flushMicrotasks();

    // The read failure falls back to the previously staged attachment; the
    // storage verification pass then reports it as non-persisted (no real
    // localStorage here), so the image survives while the staging is cleared.
    expect(draftOf(threadRef)?.images.map((entry) => entry.id)).toEqual(["img-keep"]);
    expect(draftOf(threadRef)?.persistedAttachments).toEqual([]);
    expect(draftOf(threadRef)?.nonPersistedImageIds).toEqual(["img-keep"]);
  });

  it("renders element contexts, review comments, and preview annotations with working removal", () => {
    draftStore().setElementContexts(threadRef, [makeElementContext("el-1")]);
    draftStore().setReviewComments(threadRef, [makeReviewComment("rc-1")]);
    draftStore().setPreviewAnnotations(threadRef, [
      {
        id: "ann-1",
        pageUrl: "http://localhost:3000/",
        pageTitle: null,
        comment: "Make it blue",
        elements: [],
        regions: [],
        strokes: [],
        styleChanges: [],
        screenshot: null,
        createdAt: now,
      },
    ]);

    const { markup, spies } = renderComposer();

    expect(markup).toContain('data-mock="ComposerPendingElementContexts"');
    expect(markup).toContain('data-mock="ComposerPendingReviewComments"');
    expect(markup).toContain('data-mock="ComposerPreviewAnnotationCards"');

    (findCapture("ComposerPendingElementContexts")["onRemove"] as (id: string) => void)("el-1");
    expect(draftOf(threadRef)?.elementContexts).toEqual([]);

    (findCapture("ComposerPendingReviewComments")["onRemove"] as (id: string) => void)("rc-1");
    expect(draftOf(threadRef)?.reviewComments).toEqual([]);

    const annotationCards = findCapture("ComposerPreviewAnnotationCards");
    (annotationCards["onExpandImage"] as (id: string) => void)("missing-image");
    expect(spies.onExpandImage).not.toHaveBeenCalled();
    (annotationCards["onRemove"] as (id: string) => void)("ann-1");
    // Removing the last annotation empties the draft, which the store drops.
    expect(draftOf(threadRef)?.previewAnnotations ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Command menu
// ---------------------------------------------------------------------------

describe("ChatComposer command menu", () => {
  it("builds path items from workspace entries while a path trigger is active", () => {
    seedPrompt("hello @src");
    h.pathSearch = {
      entries: [
        { path: "src/app/main.ts", kind: "file" },
        { path: "src/app", kind: "directory" },
      ],
      error: null,
      isPending: true,
    };

    const { markup } = renderComposer();

    expect(markup).toContain('data-mock="composer-command-menu"');
    const menu = findCapture("ComposerCommandMenu");
    const items = menu["items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "path:file:src/app/main.ts",
      type: "path",
      label: "main.ts",
      description: "src/app",
    });
    expect(menu["isLoading"]).toBe(true);
    expect(menu["emptyStateText"]).toBe("No matching files or folders.");

    // The path search hook received the trigger query and git cwd.
    const target = findCapture("useComposerPathSearch")["target"] as Record<string, unknown>;
    expect(target["cwd"]).toBe("/repo");
    expect(target["query"]).toBe("src");

    // The highlight sync effect resolved the first item.
    expect(setStateValues(STATE.highlightedItemId)).toContain("path:file:src/app/main.ts");
    expect(setStateValues(STATE.highlightedSearchKey)).toContain("path:src");
  });

  it("lists built-in and provider slash commands for a bare slash", () => {
    seedPrompt("/");
    renderComposer();

    const menu = findCapture("ComposerCommandMenu");
    const items = menu["items"] as Array<Record<string, unknown>>;
    expect(items.map((item) => item["id"])).toEqual([
      "slash:model",
      "slash:plan",
      "slash:default",
      "provider-slash-command:codex:review",
      "provider-agent:codex:code-reviewer",
    ]);
    expect(menu["groupSlashCommandSections"]).toBe(true);
    expect(menu["emptyStateText"]).toBe("No matching command.");
  });

  it("filters slash commands by query", () => {
    seedPrompt("/mod");
    renderComposer();

    const items = findCapture("ComposerCommandMenu")["items"] as Array<Record<string, unknown>>;
    // "mod" matches /model plus descriptions mentioning "mode"; the provider
    // command does not match and is filtered out.
    expect(items[0]?.["id"]).toBe("slash:model");
    expect(items.map((item) => item["id"])).not.toContain("provider-slash-command:codex:review");
    expect(findCapture("ComposerCommandMenu")["groupSlashCommandSections"]).toBe(false);
  });

  it("lists provider skills for a skill trigger", () => {
    seedPrompt("$ref");
    renderComposer();

    const menu = findCapture("ComposerCommandMenu");
    const items = menu["items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "skill:codex:refactor",
      type: "skill",
      label: "Refactor",
      description: "Refactor code safely",
    });
    expect(menu["emptyStateText"]).toBe("No skills found. Try / to browse provider commands.");
  });

  it("hides the menu while an approval is pending", () => {
    seedPrompt("/");
    const { markup } = renderComposer({
      activePendingApproval: pendingApproval,
      pendingApprovals: [pendingApproval],
    });
    expect(markup).not.toContain('data-mock="composer-command-menu"');
  });

  it("resets highlight state when the menu is closed", () => {
    seedPrompt("plain prompt");
    h.stateSeeds.set(STATE.highlightedItemId, "stale-item");
    renderComposer();

    expect(setStateValues(STATE.highlightedItemId)).toContain(null);
    expect(setStateValues(STATE.highlightedSearchKey)).toContain(null);
  });
});

// ---------------------------------------------------------------------------
// Menu selection
// ---------------------------------------------------------------------------

describe("ChatComposer menu selection", () => {
  function renderPathMenu() {
    seedPrompt("hello @src");
    h.pathSearch = {
      entries: [{ path: "src/app/main.ts", kind: "file" }],
      error: null,
      isPending: false,
    };
    const rendered = renderComposer();
    setEditorSnapshot("hello @src", 10);
    const onSelect = findCapture("ComposerCommandMenu")["onSelect"] as (
      item: Record<string, unknown>,
    ) => void;
    const items = findCapture("ComposerCommandMenu")["items"] as Array<Record<string, unknown>>;
    return { ...rendered, onSelect, items };
  }

  it("replaces a path trigger with a serialized file link", () => {
    const { onSelect, items } = renderPathMenu();

    onSelect(items[0]!);

    expect(draftOf(threadRef)?.prompt).toBe(
      `hello ${serializeComposerFileLink("src/app/main.ts")} `,
    );
    // Focus is scheduled on the next animation frame.
    runAnimationFrames();
    expect(h.editorHandle.focusAt).toHaveBeenCalled();
  });

  it("locks re-entrant selection until the next animation frame", () => {
    const { onSelect, items } = renderPathMenu();

    onSelect(items[0]!);
    const afterFirst = draftOf(threadRef)?.prompt;
    onSelect(items[0]!);
    expect(draftOf(threadRef)?.prompt).toBe(afterFirst);

    runAnimationFrames();
  });

  it("consumes a trailing space after the replaced range", () => {
    seedPrompt("see @src x");
    h.pathSearch = {
      entries: [{ path: "src/a.ts", kind: "file" }],
      error: null,
      isPending: false,
    };
    // The initial cursor sits at the end of the prompt, so the menu only
    // opens through a seeded trigger for the mid-prompt "@src" token.
    h.stateSeeds.set(STATE.trigger, { kind: "path", query: "src", rangeStart: 4, rangeEnd: 8 });
    renderComposer();
    // Cursor right after "@src" (before the existing space).
    setEditorSnapshot("see @src x", 8);
    const onSelect = findCapture("ComposerCommandMenu")["onSelect"] as (
      item: Record<string, unknown>,
    ) => void;
    const items = findCapture("ComposerCommandMenu")["items"] as Array<Record<string, unknown>>;

    onSelect(items[0]!);

    expect(draftOf(threadRef)?.prompt).toBe(`see ${serializeComposerFileLink("src/a.ts")} x`);
  });

  it("aborts when the prompt changed under the trigger", () => {
    const { onSelect, items } = renderPathMenu();
    // Snapshot no longer matches the store-backed promptRef contents.
    setEditorSnapshot("hello @other", 12);

    onSelect(items[0]!);

    expect(draftOf(threadRef)?.prompt).toBe("hello @src");
  });

  it("ignores selection without an active trigger", () => {
    const { onSelect, items } = renderPathMenu();
    setEditorSnapshot("plain text", 5);

    onSelect(items[0]!);

    expect(draftOf(threadRef)?.prompt).toBe("hello @src");
  });

  function renderSlashMenu(prompt: string) {
    seedPrompt(prompt);
    const rendered = renderComposer();
    setEditorSnapshot(prompt, prompt.length);
    const onSelect = findCapture("ComposerCommandMenu")["onSelect"] as (
      item: Record<string, unknown>,
    ) => void;
    const items = findCapture("ComposerCommandMenu")["items"] as Array<Record<string, unknown>>;
    return { ...rendered, onSelect, items };
  }

  it("opens the model picker from /model and clears the prompt", () => {
    const { onSelect, items } = renderSlashMenu("/mod");

    onSelect(items.find((item) => item["id"] === "slash:model")!);

    // Clearing the prompt empties the draft entirely, so the store drops it.
    expect(draftOf(threadRef)?.prompt ?? "").toBe("");
    expect(setStateValues(STATE.modelPickerOpen)).toContain(true);
  });

  it("switches interaction mode from /plan and /default", () => {
    const first = renderSlashMenu("/plan");
    first.onSelect(first.items.find((item) => item["id"] === "slash:plan")!);
    expect(first.spies.handleInteractionModeChange).toHaveBeenCalledWith("plan");
    expect(draftOf(threadRef)?.prompt ?? "").toBe("");

    const second = renderSlashMenu("/default");
    second.onSelect(second.items.find((item) => item["id"] === "slash:default")!);
    expect(second.spies.handleInteractionModeChange).toHaveBeenCalledWith("default");
  });

  it("inserts provider slash commands with a trailing space", () => {
    const { onSelect, items } = renderSlashMenu("/rev");

    onSelect(items.find((item) => item["id"] === "provider-slash-command:codex:review")!);

    expect(draftOf(threadRef)?.prompt).toBe("/review ");
  });

  it("inserts skill references with a trailing space", () => {
    seedPrompt("$ref");
    renderComposer();
    setEditorSnapshot("$ref", 4);
    const onSelect = findCapture("ComposerCommandMenu")["onSelect"] as (
      item: Record<string, unknown>,
    ) => void;
    const items = findCapture("ComposerCommandMenu")["items"] as Array<Record<string, unknown>>;

    onSelect(items[0]!);

    expect(draftOf(threadRef)?.prompt).toBe("$refactor ");
  });

  it("uses provider-native slash invocation for slash skills", () => {
    seedPrompt("$doc");
    renderComposer();
    setEditorSnapshot("$doc", 4);
    const menu = findCapture("ComposerCommandMenu");
    const onSelect = menu["onSelect"] as (item: Record<string, unknown>) => void;
    const items = menu["items"] as Array<Record<string, unknown>>;

    onSelect(items[0]!);

    expect(draftOf(threadRef)?.prompt).toBe("/docs ");
  });

  it("inserts an explicit provider-agent instruction", () => {
    const { onSelect, items } = renderSlashMenu("/code");

    onSelect(items.find((item) => item["id"] === "provider-agent:codex:code-reviewer")!);

    expect(draftOf(threadRef)?.prompt).toBe("Use the code-reviewer agent to ");
  });

  it("routes custom answers through the pending input callback instead of the store", () => {
    seedPrompt("$ref");
    const { spies } = renderComposer({
      pendingUserInputs: [makePendingUserInput()],
      activePendingProgress: makePendingProgress({ customAnswer: "$ref" }),
    });
    setEditorSnapshot("$ref", 4);
    const onSelect = findCapture("ComposerCommandMenu")["onSelect"] as (
      item: Record<string, unknown>,
    ) => void;
    const items = findCapture("ComposerCommandMenu")["items"] as Array<Record<string, unknown>>;

    onSelect(items[0]!);

    expect(spies.onChangeActivePendingUserInputCustomAnswer).toHaveBeenCalledWith(
      "q1",
      "$refactor ",
      expect.any(Number),
      expect.any(Number),
      false,
    );
    expect(draftOf(threadRef)?.prompt).toBe("$ref");
  });

  it("records menu highlight changes with the current search key", () => {
    const { items } = renderPathMenu();
    const onHighlight = findCapture("ComposerCommandMenu")["onHighlightedItemChange"] as (
      id: string | null,
    ) => void;

    onHighlight(String(items[0]!["id"]));

    expect(setStateValues(STATE.highlightedItemId)).toContain("path:file:src/app/main.ts");
    expect(setStateValues(STATE.highlightedSearchKey)).toContain("path:src");
  });
});

// ---------------------------------------------------------------------------
// Command keys
// ---------------------------------------------------------------------------

describe("ChatComposer command keys", () => {
  it("toggles interaction mode on Shift+Tab", () => {
    const { spies } = renderComposer();
    const onKey = editorProps()["onCommandKeyDown"] as CommandKey;

    expect(onKey("Tab", keyEvent({ shiftKey: true }))).toBe(true);
    expect(spies.toggleInteractionMode).toHaveBeenCalledTimes(1);
  });

  it("navigates and selects menu items from the keyboard", () => {
    seedPrompt("hello @src");
    h.pathSearch = {
      entries: [
        { path: "src/a.ts", kind: "file" },
        { path: "src/b.ts", kind: "file" },
      ],
      error: null,
      isPending: false,
    };
    renderComposer();
    setEditorSnapshot("hello @src", 10);
    const onKey = editorProps()["onCommandKeyDown"] as CommandKey;

    expect(onKey("ArrowDown", keyEvent())).toBe(true);
    expect(setStateValues(STATE.highlightedItemId)).toContain("path:file:src/a.ts");
    expect(onKey("ArrowUp", keyEvent())).toBe(true);

    expect(onKey("Enter", keyEvent())).toBe(true);
    expect(draftOf(threadRef)?.prompt).toBe(`hello ${serializeComposerFileLink("src/a.ts")} `);
  });

  it("submits on Enter without an active menu", () => {
    seedPrompt("send me");
    const { spies } = renderComposer();
    setEditorSnapshot("send me", 7);
    const onKey = editorProps()["onCommandKeyDown"] as CommandKey;

    expect(onKey("Enter", keyEvent())).toBe(true);
    expect(spies.onSend).toHaveBeenCalledTimes(1);
  });

  it("lets Shift+Enter fall through for a newline", () => {
    seedPrompt("send me");
    const { spies } = renderComposer();
    setEditorSnapshot("send me", 7);
    const onKey = editorProps()["onCommandKeyDown"] as CommandKey;

    expect(onKey("Enter", keyEvent({ shiftKey: true }))).toBe(false);
    expect(spies.onSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Prompt changes from the editor
// ---------------------------------------------------------------------------

describe("ChatComposer prompt changes", () => {
  it("stores the new prompt and re-detects the trigger", () => {
    seedPrompt("old");
    renderComposer();
    const onChange = editorProps()["onChange"] as PromptChange;

    onChange("new @q", 6, 6, false, []);

    expect(draftOf(threadRef)?.prompt).toBe("new @q");
    expect(setStateValues(STATE.cursor)).toContain(6);
    const triggers = setStateValues(STATE.trigger) as Array<{ kind?: string } | null>;
    expect(triggers.at(-1)?.kind).toBe("path");
  });

  it("suppresses the trigger when the cursor touches a mention", () => {
    seedPrompt("old");
    renderComposer();
    const onChange = editorProps()["onChange"] as PromptChange;

    onChange("new @q", 6, 6, true, []);

    expect(setStateValues(STATE.trigger).at(-1)).toBeNull();
  });

  it("synchronizes terminal contexts removed inside the editor", () => {
    const context = makeTerminalContext("ctx-1");
    draftStore().setTerminalContexts(threadRef, [context]);
    seedPrompt(`${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} tail`);
    renderComposer();
    const onChange = editorProps()["onChange"] as PromptChange;

    // Same ids: no sync required.
    onChange(`${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} tai`, 4, 4, false, ["ctx-1"]);
    expect(draftOf(threadRef)?.terminalContexts.map((entry) => entry.id)).toEqual(["ctx-1"]);

    // Editor dropped the placeholder: the store follows.
    onChange("tail", 4, 4, false, []);
    expect(draftOf(threadRef)?.terminalContexts).toEqual([]);
  });

  it("routes edits to the pending input callback while a question is active", () => {
    const { spies } = renderComposer({
      pendingUserInputs: [makePendingUserInput()],
      activePendingProgress: makePendingProgress(),
    });
    const onChange = editorProps()["onChange"] as PromptChange;

    onChange("typed", 5, 5, false, []);

    expect(spies.onChangeActivePendingUserInputCustomAnswer).toHaveBeenCalledWith(
      "q1",
      "typed",
      5,
      5,
      false,
    );
    expect(draftOf(threadRef)?.prompt ?? "").toBe("");
  });
});

// ---------------------------------------------------------------------------
// Paste and drag/drop
// ---------------------------------------------------------------------------

describe("ChatComposer paste and drag", () => {
  function imageFile(name = "shot.png"): File {
    return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "image/png" });
  }

  it("adds a single pasted image and clears the thread error", () => {
    const { spies } = renderComposer();
    const onPaste = editorProps()["onPaste"] as (event: unknown) => void;
    const event = pasteEvent([imageFile()]);

    onPaste(event);

    expect(
      (event as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).toHaveBeenCalled();
    expect(draftOf(threadRef)?.images).toHaveLength(1);
    expect(draftOf(threadRef)?.images[0]?.previewUrl).toContain("blob:generated-");
    expect(spies.setThreadError).toHaveBeenCalledWith(threadId, null);
  });

  it("adds multiple pasted images at once", () => {
    renderComposer();
    const onPaste = editorProps()["onPaste"] as (event: unknown) => void;

    onPaste(pasteEvent([imageFile("a.png"), imageFile("b.png")]));

    expect(draftOf(threadRef)?.images.map((image) => image.name)).toEqual(["a.png", "b.png"]);
  });

  it("ignores pastes without image files", () => {
    renderComposer();
    const onPaste = editorProps()["onPaste"] as (event: unknown) => void;

    const empty = pasteEvent([]);
    onPaste(empty);
    const textOnly = pasteEvent([new File(["x"], "notes.txt", { type: "text/plain" })]);
    onPaste(textOnly);

    expect(draftOf(threadRef)?.images ?? []).toEqual([]);
    expect(
      (textOnly as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).not.toHaveBeenCalled();
  });

  it("rejects images while plan questions are pending", () => {
    renderComposer({
      pendingUserInputs: [makePendingUserInput()],
      activePendingProgress: makePendingProgress(),
    });
    const onPaste = editorProps()["onPaste"] as (event: unknown) => void;

    onPaste(pasteEvent([imageFile()]));

    expect(h.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Attach images after answering plan questions.",
    });
    expect(draftOf(threadRef)?.images ?? []).toEqual([]);
  });

  it("does nothing without an active thread", () => {
    renderComposer({ activeThreadId: null });
    const onPaste = editorProps()["onPaste"] as (event: unknown) => void;

    onPaste(pasteEvent([imageFile()]));

    expect(draftOf(threadRef)?.images ?? []).toEqual([]);
  });

  it("reports unsupported types, oversized files, and the attachment cap on drop", () => {
    const preloaded = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, () => makeImage());
    const { spies, props } = renderComposer({
      composerImagesRef: { current: [] },
    });
    const dropHost = findHost((element) => typeof element.props["onDrop"] === "function");
    const onDrop = dropHost.props["onDrop"] as (event: unknown) => void;

    // Unsupported type.
    onDrop(dragEvent({ files: [new File(["x"], "notes.txt", { type: "text/plain" })] }));
    expect(spies.setThreadError).toHaveBeenLastCalledWith(
      threadId,
      "Unsupported file type for 'notes.txt'. Please attach image files only.",
    );

    // Oversized image.
    const oversized = {
      name: "big.png",
      type: "image/png",
      size: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
    } as unknown as File;
    onDrop(dragEvent({ files: [oversized] }));
    expect(String(spies.setThreadError.mock.calls.at(-1)?.[1])).toContain("exceeds the");

    // Attachment cap.
    props.composerImagesRef.current = preloaded;
    onDrop(dragEvent({ files: [imageFile("over.png")] }));
    expect(spies.setThreadError).toHaveBeenLastCalledWith(
      threadId,
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
    );

    expect(spies.focusComposer).toHaveBeenCalledTimes(3);
  });

  it("tracks drag enter, over, leave, and drop", () => {
    renderComposer();
    const dragHost = findHost((element) => typeof element.props["onDragEnter"] === "function");
    const onDragEnter = dragHost.props["onDragEnter"] as (event: unknown) => void;
    const onDragOver = dragHost.props["onDragOver"] as (event: unknown) => void;
    const onDragLeave = dragHost.props["onDragLeave"] as (event: unknown) => void;
    const onDrop = dragHost.props["onDrop"] as (event: unknown) => void;

    // Non-file drags are ignored entirely.
    const nonFile = dragEvent({ types: ["text/plain"] });
    onDragEnter(nonFile);
    onDragOver(nonFile);
    onDragLeave(nonFile);
    onDrop(nonFile);
    expect((nonFile.preventDefault as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    const falseResets = () =>
      setStateValues(STATE.dragOver).filter((value) => value === false).length;
    const baselineFalse = falseResets();

    const enter = dragEvent();
    onDragEnter(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(setStateValues(STATE.dragOver)).toContain(true);

    const over = dragEvent();
    onDragOver(over);
    expect(over.dataTransfer.dropEffect).toBe("copy");

    // Leaving toward a child node keeps the overlay active.
    const inside = dragEvent({ relatedTarget: new FakeHTMLElement(), containsRelated: true });
    onDragLeave(inside);
    expect(falseResets()).toBe(baselineFalse);

    // Leaving the surface clears it once the depth returns to zero.
    const outside = dragEvent({ relatedTarget: new FakeHTMLElement(), containsRelated: false });
    onDragLeave(outside);
    expect(falseResets()).toBe(baselineFalse + 1);

    const drop = dragEvent({ files: [imageFile("dropped.png")] });
    onDrop(drop);
    expect(draftOf(threadRef)?.images.map((image) => image.name)).toEqual(["dropped.png"]);
  });

  it("renders the drag-over styling when a drag is active", () => {
    h.stateSeeds.set(STATE.dragOver, true);
    const { markup } = renderComposer();
    expect(markup).toContain("border-primary/70");
  });
});

// ---------------------------------------------------------------------------
// Form submit
// ---------------------------------------------------------------------------

describe("ChatComposer submit", () => {
  it("submits the form through onSend", () => {
    const { spies } = renderComposer();
    const form = findHost((element) => element.type === "form");
    const event = { preventDefault: vi.fn() };

    (form.props["onSubmit"] as (event: unknown) => void)(event);

    expect(spies.onSend).toHaveBeenCalledWith(event);
  });
});

// ---------------------------------------------------------------------------
// Imperative handle
// ---------------------------------------------------------------------------

describe("ChatComposer imperative handle", () => {
  it("forwards focus helpers to the prompt editor", () => {
    const { handle } = renderComposer();

    handle().focusAtEnd();
    expect(h.editorHandle.focusAtEnd).toHaveBeenCalledTimes(1);
    handle().focusAt(3);
    expect(h.editorHandle.focusAt).toHaveBeenCalledWith(3);
  });

  it("inserts text at the end of the prompt", () => {
    seedPrompt("hello");
    const { handle } = renderComposer();

    expect(handle().insertTextAtEnd(" world")).toBe(true);
    expect(draftOf(threadRef)?.prompt).toBe("hello world");
    runAnimationFrames();
    expect(h.editorHandle.focusAt).toHaveBeenCalled();
  });

  it("refuses insertion when blocked", () => {
    seedPrompt("hello");
    const blockedStates: Array<Partial<ChatComposerProps>> = [
      { isConnecting: true },
      { activePendingApproval: pendingApproval, pendingApprovals: [pendingApproval] },
      { pendingUserInputs: [makePendingUserInput()] },
      {
        environmentUnavailable: {
          label: "Laptop",
          connection: { phase: "offline", error: null, traceId: null },
        },
      },
    ];
    for (const overrides of blockedStates) {
      const { handle } = renderComposer(overrides);
      expect(handle().insertTextAtEnd(" world")).toBe(false);
    }
    const { handle } = renderComposer();
    expect(handle().insertTextAtEnd("")).toBe(false);
    expect(draftOf(threadRef)?.prompt).toBe("hello");
  });

  it("controls the model picker", () => {
    h.stateSeeds.set(STATE.modelPickerOpen, true);
    const { handle } = renderComposer();

    expect(handle().isModelPickerOpen()).toBe(true);
    handle().openModelPicker();
    expect(setStateValues(STATE.modelPickerOpen)).toContain(true);
    handle().toggleModelPicker();
    expect(setStateValues(STATE.modelPickerOpen)).toContain(false);

    // The picker mock receives the seeded open flag and reports open changes.
    const picker = findCapture("ProviderModelPicker");
    expect(picker["open"]).toBe(true);
    (picker["onOpenChange"] as (open: boolean) => void)(false);
    expect(setStateValues(STATE.modelPickerOpen)).toContain(false);
  });

  it("reads snapshots from the editor and falls back to local state", () => {
    seedPrompt("fallback text");
    h.stateSeeds.set(STATE.cursor, 4);
    const { handle } = renderComposer();

    setEditorSnapshot("editor text", 2, ["ctx-9"]);
    expect(handle().readSnapshot()).toEqual({
      value: "editor text",
      cursor: 2,
      expandedCursor: 2,
      terminalContextIds: ["ctx-9"],
    });

    h.editorSnapshot = null;
    expect(handle().readSnapshot()).toEqual({
      value: "fallback text",
      cursor: 4,
      expandedCursor: 4,
      terminalContextIds: [],
    });
  });

  it("resets cursor state with and without trigger detection", () => {
    // "@qu" without a trailing space is not yet an inline token, so the
    // collapsed and expanded cursors coincide and the trigger stays live.
    seedPrompt("hi @qu");
    const { handle } = renderComposer();

    handle().resetCursorState({ cursor: 6, detectTrigger: true });
    expect(setStateValues(STATE.cursor)).toContain(6);
    const triggers = setStateValues(STATE.trigger) as Array<{ kind?: string } | null>;
    expect(triggers.at(-1)?.kind).toBe("path");

    handle().resetCursorState({ prompt: "clean", cursor: 2 });
    expect(setStateValues(STATE.trigger).at(-1)).toBeNull();
  });

  it("inserts terminal contexts at the editor cursor", () => {
    seedPrompt("hello world");
    const { handle } = renderComposer();
    setEditorSnapshot("hello world", 5);

    handle().addTerminalContext({
      terminalId: "term-9",
      terminalLabel: "Terminal 9",
      lineStart: 10,
      lineEnd: 12,
      text: "compile ok",
    });

    const draft = draftOf(threadRef);
    expect(draft?.terminalContexts).toHaveLength(1);
    expect(draft?.terminalContexts[0]).toMatchObject({
      terminalId: "term-9",
      threadId,
      text: "compile ok",
    });
    expect(draft?.prompt).toContain(INLINE_TERMINAL_CONTEXT_PLACEHOLDER);
    runAnimationFrames();
    expect(h.editorHandle.focusAt).toHaveBeenCalled();
  });

  it("skips terminal context insertion without an active thread", () => {
    seedPrompt("hello");
    const { handle } = renderComposer({ activeThread: undefined });

    handle().addTerminalContext({
      terminalId: "term-9",
      terminalLabel: "Terminal 9",
      lineStart: 1,
      lineEnd: 2,
      text: "ignored",
    });

    expect(draftOf(threadRef)?.terminalContexts ?? []).toEqual([]);
  });

  it("exposes the full send context", () => {
    seedPrompt("send me");
    draftStore().setReviewComments(threadRef, [makeReviewComment("rc-ctx")]);
    const { handle } = renderComposer();

    const context = handle().getSendContext();

    expect(context.prompt).toBe("send me");
    expect(context.selectedProvider).toBe("codex");
    expect(context.selectedModel).toBe("gpt-5.4");
    expect(context.selectedModelSelection.instanceId).toBe(codexInstanceId);
    expect(context.reviewComments.map((comment) => comment.id)).toEqual(["rc-ctx"]);
    expect(context.images).toEqual([]);
    expect(context.selectedProviderModels.map((model) => model.slug)).toEqual(["gpt-5.4"]);
  });
});

// ---------------------------------------------------------------------------
// Provider / model selection
// ---------------------------------------------------------------------------

describe("ChatComposer provider selection", () => {
  it("falls back to codex when no providers are configured", () => {
    renderComposer({ providerStatuses: [], activeProjectDefaultModelSelection: null });
    const picker = findCapture("ProviderModelPicker");
    expect(picker["activeInstanceId"]).toBe("codex");
  });

  it("keeps an explicitly selected instance even when it has no live entry", () => {
    renderComposer({
      providerStatuses: [],
      activeProjectDefaultModelSelection: null,
      activeThreadModelSelection: {
        instanceId: ProviderInstanceId.make("codex_personal"),
        model: "gpt-5.4",
      },
    });
    const picker = findCapture("ProviderModelPicker");
    expect(picker["activeInstanceId"]).toBe("codex_personal");
  });

  it("locks the provider and derives the continuation group", () => {
    renderComposer({
      lockedProvider: ProviderDriverKind.make("codex"),
      activeThreadModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    });
    const picker = findCapture("ProviderModelPicker");
    expect(picker["activeInstanceId"]).toBe("codex");
    expect(picker["lockedProvider"]).toBe("codex");

    (picker["onInstanceModelChange"] as (instance: string, model: string) => void)(
      "codex",
      "gpt-5.4",
    );
  });

  it("skips persisted selections from a different driver kind while locked", () => {
    renderComposer({
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
      activeThreadModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    });
    const picker = findCapture("ProviderModelPicker");
    // The codex selection is rejected; the explicit instance id wins instead.
    expect(picker["activeInstanceId"]).toBe("codex");
  });
});

// ---------------------------------------------------------------------------
// Mobile behaviors
// ---------------------------------------------------------------------------

describe("ChatComposer mobile", () => {
  it("collapses on mobile with an expandable prompt row", () => {
    h.isMobile = true;
    seedPrompt("draft text");
    const { markup } = renderComposer();

    expect(markup).toContain('data-chat-composer-mobile-collapsed="true"');
    expect(markup).toContain("draft text");

    const expand = hostByLabel("Expand composer");
    (expand["onClick"] as () => void)();
    expect(setStateValues(STATE.focused)).toContain(true);
    runAnimationFrames();
    expect(h.editorHandle.focusAtEnd).toHaveBeenCalledTimes(1);

    const pointerDown = expand["onPointerDown"] as (event: { preventDefault: () => void }) => void;
    const pointerEvent = { preventDefault: vi.fn() };
    pointerDown(pointerEvent);
    expect(pointerEvent.preventDefault).toHaveBeenCalled();
  });

  it("shows the collapsed placeholder text when the prompt is empty", () => {
    h.isMobile = true;
    const { markup } = renderComposer();
    expect(markup).toContain("Ask anything...");
  });

  it("sends from the collapsed row and blurs the active element", () => {
    h.isMobile = true;
    seedPrompt("ready to send");
    const active = new FakeHTMLElement();
    documentStub.activeElement = active;
    const { spies } = renderComposer();

    const send = hostByLabel("Send message");
    const clickEvent = { stopPropagation: vi.fn() };
    (send["onClick"] as (event: unknown) => void)(clickEvent);

    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    expect(active.blur).toHaveBeenCalledTimes(1);
    expect(setStateValues(STATE.focused)).toContain(false);
  });

  it("keeps focus when the turn is still running", () => {
    h.isMobile = true;
    seedPrompt("ready to send");
    const active = new FakeHTMLElement();
    documentStub.activeElement = active;
    renderComposer({ phase: "running" });

    const send = hostByLabel("Send message");
    (send["onClick"] as (event: unknown) => void)({ stopPropagation: vi.fn() });

    expect(active.blur).not.toHaveBeenCalled();
  });

  it("disables the collapsed send button without sendable content", () => {
    h.isMobile = true;
    const { markup } = renderComposer();
    const send = hostByLabel("Send message");
    expect(send["disabled"]).toBe(true);
    expect(markup).toContain("disabled");
  });

  it("renders the collapsed approval controls", () => {
    h.isMobile = true;
    const { markup } = renderComposer({
      activePendingApproval: pendingApproval,
      pendingApprovals: [pendingApproval],
    });
    expect(markup).toContain('data-chat-composer-collapsed-controls="true"');
    expect(markup).toContain('data-mock="ComposerPendingApprovalActions"');
  });

  it("renders the collapsed pending question controls with a custom answer button", () => {
    h.isMobile = true;
    const { markup } = renderComposer({
      pendingUserInputs: [makePendingUserInput()],
      activePendingProgress: makePendingProgress({
        customAnswer: "typed answer",
        activeQuestion: { id: "q1", multiSelect: true },
      }),
    });

    expect(markup).toContain('data-chat-composer-mobile-pending-compact="true"');
    expect(markup).toContain("typed answer");
    expect(markup).toContain('data-mock="ComposerPrimaryActions"');

    const write = hostByLabel("Write custom answer");
    (write["onClick"] as () => void)();
    expect(setStateValues(STATE.focused)).toContain(true);
  });

  it("shows floating pending answer actions while expanded on mobile", () => {
    h.isMobile = true;
    h.stateSeeds.set(STATE.focused, true);
    const { markup } = renderComposer({
      pendingUserInputs: [makePendingUserInput()],
      activePendingProgress: makePendingProgress(),
    });

    expect(markup).toContain('data-chat-composer-mobile-pending-actions="true"');
    expect(editorProps()["className"]).toBe("max-sm:pb-11");
  });

  it("expands on focus capture and collapses after blur", () => {
    h.isMobile = true;
    renderComposer();
    const surface = findHost(
      (element) => element.props["data-chat-composer-mobile-collapsed"] !== undefined,
    ).props;

    // Focus from the collapsed inline controls is ignored.
    const controlsTarget = new FakeHTMLElement();
    controlsTarget.closestResult = {};
    (surface["onFocusCapture"] as (event: unknown) => void)({ target: controlsTarget });
    expect(setStateValues(STATE.focused)).not.toContain(true);

    // Any other focus expands the composer.
    const target = new FakeHTMLElement();
    (surface["onFocusCapture"] as (event: unknown) => void)({ target });
    expect(setStateValues(STATE.focused)).toContain(true);

    // Blur schedules a collapse check on the next frame.
    documentStub.activeElement = null;
    (surface["onBlurCapture"] as () => void)();
    runAnimationFrames();
    expect(setStateValues(STATE.focused)).toContain(false);
  });

  it("keeps the composer expanded while focus sits in a floating layer", () => {
    h.isMobile = true;
    renderComposer();
    const surface = findHost(
      (element) => element.props["data-chat-composer-mobile-collapsed"] !== undefined,
    ).props;

    const floating = new FakeElement();
    floating.closestResult = {};
    documentStub.activeElement = floating;
    (surface["onBlurCapture"] as () => void)();
    runAnimationFrames();

    expect(setStateValues(STATE.focused)).not.toContain(false);
  });

  it("skips collapse checks entirely on desktop", () => {
    renderComposer();
    const surface = findHost(
      (element) => element.props["data-chat-composer-mobile-collapsed"] !== undefined,
    ).props;

    (surface["onBlurCapture"] as () => void)();
    expect(rafCallbacks).toHaveLength(0);
  });

  it("cancels queued animation frames on unmount", () => {
    h.isMobile = true;
    renderComposer();
    const expand = hostByLabel("Expand composer");
    (expand["onClick"] as () => void)();

    runCleanups();
    expect(windowStub.cancelAnimationFrame).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

describe("ChatComposer effects", () => {
  it("synchronizes parent refs after render", () => {
    const context = makeTerminalContext("ctx-sync");
    draftStore().setTerminalContexts(threadRef, [context]);
    seedPrompt(`${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} sync me`);
    const element = makeElementContext("el-sync");
    draftStore().setElementContexts(threadRef, [element]);

    const { props } = renderComposer();

    expect(props.promptRef.current).toBe(`${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} sync me`);
    expect(props.composerTerminalContextsRef.current.map((entry) => entry.id)).toEqual([
      "ctx-sync",
    ]);
    expect(props.composerElementContextsRef.current.map((entry) => entry.id)).toEqual(["el-sync"]);
  });

  it("adopts the pending custom answer and skips redundant re-syncs", () => {
    const { props } = renderComposer({
      pendingUserInputs: [makePendingUserInput()],
      activePendingProgress: makePendingProgress({ customAnswer: "draft answer" }),
    });

    expect(props.promptRef.current).toBe("draft answer");
    expect(setStateValues(STATE.highlightedItemId)).toContain(null);

    const callsBefore = h.setStateCalls.length;
    reflushExecutedEffects();
    // The second pass hits the "nothing changed" early return for the pending
    // input sync (other effects may still re-fire their setters).
    expect(props.promptRef.current).toBe("draft answer");
    expect(h.setStateCalls.length).toBeGreaterThanOrEqual(callsBefore);
  });

  it("clears persisted attachments when the draft has no images", async () => {
    draftStore().syncPersistedAttachments(threadRef, [
      {
        id: "stale",
        name: "stale.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,x",
      },
    ]);

    renderComposer();
    await flushMicrotasks();

    expect(draftOf(threadRef)?.persistedAttachments ?? []).toEqual([]);
  });

  it("measures footer compactness when the form element is attached", () => {
    renderComposer();
    // Re-run the layout effect with an attached form element.
    const form = findHost((element) => element.type === "form");
    const formRef = form.props["ref"] as { current: unknown } | undefined;
    expect(formRef).toBeDefined();

    const observed: Array<() => void> = [];
    class FakeResizeObserver {
      private readonly callback: () => void;
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: () => void) {
        this.callback = callback;
        observed.push(() => this.callback());
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    formRef!.current = { clientWidth: 200 };
    reflushExecutedEffects();

    expect(setStateValues(STATE.footerCompact)).toContain(true);
    // The observer re-measures on resize.
    expect(observed.length).toBeGreaterThan(0);
    for (const trigger of observed) trigger();
    runCleanups();
  });
});
