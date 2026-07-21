import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import type { DesktopPreviewBridge } from "@t4code/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ previewBridge: null as DesktopPreviewBridge | null }));

vi.mock("./components/preview/previewBridge", () => ({
  get previewBridge() {
    return h.previewBridge;
  },
}));

import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { registerPreviewRuntimeCapabilities } from "./previewRuntimeCapabilities";
import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  beforeEach(() => {
    h.previewBridge = {} as DesktopPreviewBridge;
  });

  it("shares the application atom registry with routed UI and preview automation", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(children).toHaveLength(2);
    expect(isValidElement(children[0]) && children[0].type).toBe(RouterProvider);
    expect(isValidElement(children[1]) && children[1].type).toBe(PreviewAutomationHosts);
  });

  it("omits preview automation hosts when the runtime does not support automation", () => {
    const bridge = {} as DesktopPreviewBridge;
    registerPreviewRuntimeCapabilities(bridge, {
      picker: false,
      recording: false,
      automation: false,
      imageClipboard: false,
    });
    h.previewBridge = bridge;

    const root = AppRoot({ router: {} as AppRouter });
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );

    expect(children).toHaveLength(1);
    expect(isValidElement(children[0]) && children[0].type).toBe(RouterProvider);
  });
});
