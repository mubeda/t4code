"use client";

import type { ScopedThreadRef } from "@t4code/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";

import { usePreviewBridge } from "~/components/preview/usePreviewBridge";

import { acquireBrowserSurface } from "./browserSurfaceStore";
import { acquireDesktopTab } from "./desktopTabLifetime";

export function BrowserSurfaceSlot(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly initialUrl: string | null;
  readonly visible: boolean;
  readonly className?: string;
}) {
  const { threadRef, tabId, initialUrl, visible, className } = props;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const initialNavigationRef = useRef({ tabId, url: initialUrl });

  usePreviewBridge({ threadRef, tabId });

  useLayoutEffect(() => {
    if (initialNavigationRef.current.tabId === tabId) return;
    initialNavigationRef.current = { tabId, url: initialUrl };
  }, [initialUrl, tabId]);

  useEffect(() => {
    let disposed = false;
    const lease = acquireDesktopTab(tabId);
    const capturedInitialUrl = initialNavigationRef.current.url;
    if (capturedInitialUrl !== null) {
      void lease.navigate(capturedInitialUrl, () => !disposed).catch(() => undefined);
    }
    return () => {
      disposed = true;
      lease.release();
    };
  }, [tabId]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const lease = acquireBrowserSurface(tabId);
    const update = () => {
      const rect = element.getBoundingClientRect();
      lease.present(
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        visible && rect.width > 0 && rect.height > 0,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      lease.release();
    };
  }, [tabId, visible]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}
