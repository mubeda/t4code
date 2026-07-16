import { RouterProvider } from "@tanstack/react-router";

import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/** Owns renderer-wide providers shared by routed UI and automation hosts. */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
    </AppAtomRegistryProvider>
  );
}
