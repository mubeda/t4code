import { RouterProvider } from "@tanstack/react-router";

import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { previewBridge } from "./components/preview/previewBridge";
import { supportsPreviewRuntimeCapability } from "./previewRuntimeCapabilities";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/** Owns renderer-wide providers shared by routed UI and automation hosts. */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      {supportsPreviewRuntimeCapability(previewBridge, "automation") ? (
        <PreviewAutomationHosts />
      ) : null}
    </AppAtomRegistryProvider>
  );
}
