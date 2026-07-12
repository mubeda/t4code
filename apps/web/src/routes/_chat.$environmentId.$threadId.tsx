import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { missingRouteThreadRedirectDelay, resolveThreadRouteRef } from "../threadRoutes";
import { ChatRouteInset } from "./-ChatRouteInset";
import { useEnvironmentThreadRefs, useThreadDetail, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const threadExists = serverThreadShell !== null || serverThreadDetail !== null;
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const shellStatus = shell.data?.status ?? null;

  useEffect(() => {
    if (!threadRef) {
      return;
    }

    const delay = missingRouteThreadRedirectDelay({
      shellStatus,
      routeThreadExists,
      environmentHasServerThreads,
    });
    if (delay === null) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void navigate({ to: "/", replace: true });
    }, delay);
    return () => window.clearTimeout(timeoutId);
  }, [environmentHasServerThreads, navigate, routeThreadExists, shellStatus, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  return (
    <ChatRouteInset>
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
      />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
