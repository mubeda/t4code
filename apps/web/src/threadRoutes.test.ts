import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  shouldRedirectMissingRouteThread,
} from "./threadRoutes";

describe("threadRoutes", () => {
  it("builds canonical thread route params from a scoped ref", () => {
    const ref = scopeThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(buildThreadRouteParams(ref)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("resolves a scoped ref only when both params are present", () => {
    expect(
      resolveThreadRouteRef({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(resolveThreadRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveThreadRouteRef({ threadId: "thread-1" })).toBeNull();
  });

  it("builds canonical draft route params from a draft id", () => {
    expect(buildDraftThreadRouteParams(DraftId.make("draft-1"))).toEqual({
      draftId: "draft-1",
    });
  });

  it("resolves draft and server route targets", () => {
    expect(
      resolveThreadRouteTarget({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "server",
      threadRef: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
    });

    expect(
      resolveThreadRouteTarget({
        draftId: "draft-1",
      }),
    ).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });
  });
});

describe("shouldRedirectMissingRouteThread", () => {
  it("redirects when a live snapshot lacks the thread but has other server threads", () => {
    expect(
      shouldRedirectMissingRouteThread({
        shellStatus: "live",
        routeThreadExists: false,
        environmentHasServerThreads: true,
      }),
    ).toBe(true);
  });

  it("never redirects while the shell is not live (backend flap/reconnect windows)", () => {
    for (const shellStatus of ["cached", "synchronizing", "empty", null] as const) {
      expect(
        shouldRedirectMissingRouteThread({
          shellStatus,
          routeThreadExists: false,
          environmentHasServerThreads: true,
        }),
      ).toBe(false);
    }
  });

  it("never redirects when the environment has no server threads (empty/partial early snapshot; drafts do not count)", () => {
    expect(
      shouldRedirectMissingRouteThread({
        shellStatus: "live",
        routeThreadExists: false,
        environmentHasServerThreads: false,
      }),
    ).toBe(false);
  });

  it("never redirects while the route thread exists", () => {
    expect(
      shouldRedirectMissingRouteThread({
        shellStatus: "live",
        routeThreadExists: true,
        environmentHasServerThreads: true,
      }),
    ).toBe(false);
  });
});
