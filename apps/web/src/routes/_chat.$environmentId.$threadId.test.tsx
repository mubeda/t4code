import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  routeConfig: null as Record<string, unknown> | null,
  params: { environmentId: "environment-1", threadId: "thread-1" },
  threadRef: null as null | { environmentId: string; threadId: string },
  shell: { data: undefined as undefined | { snapshot: { _tag: string }; status?: string } },
  serverShell: null as unknown,
  serverDetail: null as unknown,
  environmentRefs: [] as unknown[],
  draft: null as unknown,
  serverStarted: false,
  redirectDelay: null as number | null,
  effects: [] as Array<() => void | (() => void)>,
  navigate: vi.fn(),
  shellAtom: vi.fn((environmentId: unknown) => ({ environmentId })),
  queryInput: null as unknown,
  resolveRef: vi.fn(),
  delayInput: null as unknown,
  finalize: vi.fn(),
  chatProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: Record<string, unknown>) => {
    harness.routeConfig = config;
    return {
      ...config,
      useParams: (options: { select: (params: unknown) => unknown }) =>
        options.select(harness.params),
    };
  },
  useNavigate: () => harness.navigate,
}));
vi.mock("../components/ChatView", () => ({
  default: (props: Record<string, unknown>) => {
    harness.chatProps.push(props);
    return <div data-chat-view />;
  },
}));
vi.mock("../components/ChatView.logic", () => ({
  threadHasStarted: () => harness.serverStarted,
}));
vi.mock("../composerDraftStore", () => ({
  finalizePromotedDraftThreadByRef: (ref: unknown) => harness.finalize(ref),
  useComposerDraftStore: (selector: (store: unknown) => unknown) =>
    selector({ getDraftThreadByRef: () => harness.draft }),
}));
vi.mock("../threadRoutes", () => ({
  missingRouteThreadRedirectDelay: (input: unknown) => {
    harness.delayInput = input;
    return harness.redirectDelay;
  },
  resolveThreadRouteRef: (params: unknown) => {
    harness.resolveRef(params);
    return harness.threadRef;
  },
}));
vi.mock("./-ChatRouteInset", () => ({
  ChatRouteInset: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("../state/entities", () => ({
  useEnvironmentThreadRefs: () => harness.environmentRefs,
  useThreadDetail: () => harness.serverDetail,
  useThreadShell: () => harness.serverShell,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    harness.queryInput = input;
    return harness.shell;
  },
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateAtom: (environmentId: unknown) => harness.shellAtom(environmentId) },
}));

import { Route } from "./_chat.$environmentId.$threadId";

function renderRoute(): string {
  void Route;
  harness.effects.length = 0;
  harness.chatProps.length = 0;
  const component = harness.routeConfig?.component;
  if (typeof component !== "function") throw new Error("Missing route component");
  return renderToStaticMarkup(createElement(component as ComponentType));
}

beforeEach(() => {
  harness.threadRef = { environmentId: "environment-1", threadId: "thread-1" };
  harness.shell = { data: { snapshot: { _tag: "Some" }, status: "ready" } };
  harness.serverShell = { id: "shell" };
  harness.serverDetail = null;
  harness.environmentRefs = [];
  harness.draft = null;
  harness.serverStarted = false;
  harness.redirectDelay = null;
  harness.navigate.mockReset();
  harness.shellAtom.mockClear();
  harness.queryInput = null;
  harness.resolveRef.mockClear();
  harness.delayInput = null;
  harness.finalize.mockReset();
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("thread chat route", () => {
  it("returns null when the route reference is invalid", () => {
    harness.threadRef = null;
    expect(renderRoute()).toBe("");
    expect(harness.queryInput).toBeNull();
    expect(harness.effects[0]?.()).toBeUndefined();
    expect(harness.effects[1]?.()).toBeUndefined();
  });

  it("waits for bootstrap and for either server or draft state", () => {
    harness.shell = { data: undefined };
    expect(renderRoute()).toBe("");

    harness.shell = { data: { snapshot: { _tag: "None" } } };
    expect(renderRoute()).toBe("");

    harness.shell = { data: { snapshot: { _tag: "Some" } } };
    harness.serverShell = null;
    harness.serverDetail = null;
    harness.draft = null;
    expect(renderRoute()).toBe("");
    harness.effects[0]?.();
    expect(harness.delayInput).toMatchObject({ shellStatus: null, routeThreadExists: false });
  });

  it("renders server-detail and draft-backed threads", () => {
    harness.serverShell = null;
    harness.serverDetail = { id: "detail" };
    expect(renderRoute()).toContain("data-chat-view");
    expect(harness.chatProps[0]).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
      routeKind: "server",
    });

    harness.serverDetail = null;
    harness.draft = { id: "draft" };
    harness.environmentRefs = [{ threadId: "other" }];
    expect(renderRoute()).toContain("data-chat-view");
    harness.effects[0]?.();
    expect(harness.delayInput).toMatchObject({
      routeThreadExists: true,
      environmentHasServerThreads: true,
    });
  });

  it("redirects missing threads after the requested delay and clears the timer", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    harness.serverShell = null;
    harness.redirectDelay = 250;
    renderRoute();
    const cleanup = harness.effects[0]?.();
    vi.advanceTimersByTime(250);
    expect(harness.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
    if (typeof cleanup === "function") cleanup();

    harness.redirectDelay = null;
    renderRoute();
    expect(harness.effects[0]?.()).toBeUndefined();
  });

  it("finalizes a promoted draft only after the server thread starts", () => {
    harness.draft = { id: "draft" };
    harness.serverStarted = false;
    renderRoute();
    expect(harness.effects[1]?.()).toBeUndefined();
    expect(harness.finalize).not.toHaveBeenCalled();

    harness.serverStarted = true;
    renderRoute();
    harness.effects[1]?.();
    expect(harness.finalize).toHaveBeenCalledWith(harness.threadRef);

    harness.draft = null;
    renderRoute();
    expect(harness.effects[1]?.()).toBeUndefined();
  });
});
