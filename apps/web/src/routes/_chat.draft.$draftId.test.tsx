import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  routeConfig: null as Record<string, unknown> | null,
  rawDraftId: "draft-1",
  draftSession: null as null | {
    environmentId: string;
    threadId: string;
    promotedTo?: { environmentId: string; threadId: string };
  },
  threadRefs: [] as Array<{ environmentId: string; threadId: string }>,
  serverThread: null as unknown,
  serverStarted: false,
  effects: [] as Array<() => void | (() => void)>,
  navigate: vi.fn(),
  markPromoted: vi.fn(),
  buildParams: vi.fn((ref: unknown) => ({ built: ref })),
  chatProps: [] as Array<Record<string, unknown>>,
  useThreadRef: null as unknown,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: Record<string, unknown>) => {
    harness.routeConfig = config;
    return { ...config, useParams: () => ({ draftId: harness.rawDraftId }) };
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
  DraftId: { make: (value: string) => value },
  markPromotedDraftThreadByRef: (ref: unknown) => harness.markPromoted(ref),
  useComposerDraftStore: (selector: (store: unknown) => unknown) =>
    selector({ getDraftSession: () => harness.draftSession }),
}));
vi.mock("./-ChatRouteInset", () => ({
  ChatRouteInset: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("../threadRoutes", () => ({
  buildThreadRouteParams: (ref: unknown) => harness.buildParams(ref),
}));
vi.mock("../state/entities", () => ({
  useThread: (ref: unknown) => {
    harness.useThreadRef = ref;
    return harness.serverThread;
  },
  useThreadRefs: () => harness.threadRefs,
}));

import { Route } from "./_chat.draft.$draftId";

function renderRoute(): string {
  void Route;
  harness.effects.length = 0;
  harness.chatProps.length = 0;
  const component = harness.routeConfig?.component;
  if (typeof component !== "function") throw new Error("Missing route component");
  return renderToStaticMarkup(createElement(component as ComponentType));
}

beforeEach(() => {
  harness.rawDraftId = "draft-1";
  harness.draftSession = null;
  harness.threadRefs = [];
  harness.serverThread = null;
  harness.serverStarted = false;
  harness.navigate.mockReset();
  harness.markPromoted.mockReset();
  harness.buildParams.mockClear();
  harness.useThreadRef = null;
});

describe("draft chat route", () => {
  it("redirects home when neither a draft nor canonical thread exists", () => {
    expect(renderRoute()).toBe("");
    expect(harness.useThreadRef).toBeNull();
    expect(harness.effects[0]?.()).toBeUndefined();
    expect(harness.effects[1]?.()).toBeUndefined();
    harness.effects[2]?.();
    expect(harness.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("renders an unpromoted draft and ignores unrelated thread refs", () => {
    harness.draftSession = { environmentId: "environment-1", threadId: "thread-1" };
    harness.threadRefs = [
      { environmentId: "environment-2", threadId: "thread-1" },
      { environmentId: "environment-1", threadId: "thread-2" },
    ];
    expect(renderRoute()).toContain("data-chat-view");
    expect(harness.chatProps[0]).toMatchObject({
      draftId: "draft-1",
      environmentId: "environment-1",
      threadId: "thread-1",
      routeKind: "draft",
    });
    expect(harness.effects[0]?.()).toBeUndefined();
    expect(harness.effects[1]?.()).toBeUndefined();
    expect(harness.effects[2]?.()).toBeUndefined();
  });

  it("marks an inferred matching thread as promoted", () => {
    harness.draftSession = { environmentId: "environment-1", threadId: "thread-1" };
    const inferred = { environmentId: "environment-1", threadId: "thread-1" };
    harness.threadRefs = [inferred];
    renderRoute();
    harness.effects[0]?.();
    expect(harness.markPromoted).toHaveBeenCalledWith(inferred);
    expect(harness.useThreadRef).toBe(inferred);
  });

  it("prefers an explicit promotion and navigates once its server thread starts", () => {
    const promoted = { environmentId: "environment-2", threadId: "thread-2" };
    harness.draftSession = {
      environmentId: "environment-1",
      threadId: "thread-1",
      promotedTo: promoted,
    };
    harness.threadRefs = [{ environmentId: "environment-1", threadId: "thread-1" }];
    harness.serverThread = { id: "server" };
    harness.serverStarted = true;
    const markup = renderRoute();
    expect(markup).toContain("data-chat-view");
    expect(harness.chatProps[0]).toMatchObject({
      environmentId: "environment-2",
      threadId: "thread-2",
      routeKind: "server",
    });
    expect(harness.effects[0]?.()).toBeUndefined();
    harness.effects[1]?.();
    expect(harness.buildParams).toHaveBeenCalledWith(promoted);
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { built: promoted },
      replace: true,
    });
    expect(harness.effects[2]?.()).toBeUndefined();
  });

  it("keeps draft rendering while a promoted server thread has not started", () => {
    const promoted = { environmentId: "environment-2", threadId: "thread-2" };
    harness.draftSession = {
      environmentId: "environment-1",
      threadId: "thread-1",
      promotedTo: promoted,
    };
    harness.serverStarted = false;
    expect(renderRoute()).toContain("data-chat-view");
    expect(harness.chatProps[0]?.routeKind).toBe("draft");
    expect(harness.effects[1]?.()).toBeUndefined();
    expect(harness.effects[2]?.()).toBeUndefined();
  });
});
