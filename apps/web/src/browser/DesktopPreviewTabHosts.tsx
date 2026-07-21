"use client";

import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t4code/contracts";
import { useEffect, useRef } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";

import { acquireDesktopTab } from "./desktopTabLifetime";

export interface DesktopPreviewTabHostDescriptor {
  readonly tabId: string;
  readonly initialUrl: string;
}

export function selectDesktopPreviewTabHosts(
  surfaces: readonly RightPanelSurface[],
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): readonly DesktopPreviewTabHostDescriptor[] {
  return surfaces.flatMap((surface) => {
    if (surface.kind !== "preview" || surface.resourceId === null) return [];
    const session = sessions[surface.resourceId];
    if (!session || session.navStatus._tag === "Idle") return [];
    return [{ tabId: surface.resourceId, initialUrl: session.navStatus.url }];
  });
}

export function NativePreviewTabHost(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly initialUrl: string;
}) {
  const { threadRef, tabId, initialUrl } = props;
  const initialUrlRef = useRef(initialUrl);

  usePreviewBridge({ threadRef, tabId });

  useEffect(() => {
    let disposed = false;
    const lease = acquireDesktopTab(tabId);
    void lease.navigate(initialUrlRef.current, () => !disposed).catch(() => undefined);
    return () => {
      disposed = true;
      lease.release();
    };
  }, [tabId]);

  return null;
}

export function DesktopPreviewTabHosts(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surfaces: readonly RightPanelSurface[];
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
}) {
  const { threadRef, surfaces, sessions } = props;
  return selectDesktopPreviewTabHosts(surfaces, sessions).map(({ tabId, initialUrl }) => (
    <NativePreviewTabHost key={tabId} threadRef={threadRef} tabId={tabId} initialUrl={initialUrl} />
  ));
}
