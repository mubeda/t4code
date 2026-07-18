import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import { isDesktopHost } from "./env";
import { tauriDesktopBridgeReady } from "./tauriDesktopBridge";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import { AppRoot } from "./AppRoot";
import { installFrontendLogCapture } from "./diagnostics/frontendLogCapture";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export async function renderApplication(): Promise<void> {
  installFrontendLogCapture();
  await tauriDesktopBridgeReady.catch(() => undefined);

  // Desktop shells load bundled assets from custom/file origins, so hash history avoids path resolution issues.
  const history = isDesktopHost ? createHashHistory() : createBrowserHistory();
  const router = getRouter(history);
  const app = <AppRoot router={router} />;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {clerkPublishableKey && hasCloudPublicConfig() ? (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      ) : (
        app
      )}
    </React.StrictMode>,
  );
}
