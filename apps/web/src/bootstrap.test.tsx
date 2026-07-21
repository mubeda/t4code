import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  return {
    loadedApplicationModules: [] as string[],
    ready,
    render: vi.fn(),
    resolveReady,
  };
});

vi.mock("./tauriDesktopBridge", () => ({
  tauriDesktopBridgeReady: harness.ready,
}));

vi.mock("./router", () => {
  harness.loadedApplicationModules.push("router");
  return { getRouter: vi.fn(() => ({})) };
});

vi.mock("./AppRoot", () => {
  harness.loadedApplicationModules.push("app-root");
  return { AppRoot: () => null };
});

vi.mock("@tanstack/react-router", () => ({
  createBrowserHistory: vi.fn(() => ({})),
  createHashHistory: vi.fn(() => ({})),
}));

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: vi.fn(() => ({ render: harness.render })),
  },
}));

vi.mock("./diagnostics/frontendLogCapture", () => ({
  installFrontendLogCapture: vi.fn(),
}));

vi.mock("./env", () => ({ isDesktopHost: false }));
vi.mock("./cloud/publicConfig", () => ({ hasCloudPublicConfig: vi.fn(() => false) }));
vi.mock("./cloud/managedAuth", () => ({ ManagedRelayAuthProvider: () => null }));
vi.mock("@clerk/react", () => ({ ClerkProvider: () => null }));

describe("renderApplication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the application graph only after the desktop bridge is ready", async () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({})),
    });

    const { renderApplication } = await import("./bootstrap");

    expect(harness.loadedApplicationModules).toEqual([]);

    const rendering = renderApplication();
    await Promise.resolve();
    expect(harness.loadedApplicationModules).toEqual([]);

    harness.resolveReady();
    await rendering;

    expect(harness.loadedApplicationModules.toSorted()).toEqual(["app-root", "router"]);
    expect(harness.render).toHaveBeenCalledOnce();
  });
});
