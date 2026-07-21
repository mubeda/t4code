import { DEFAULT_CLIENT_SETTINGS, type DesktopBridge } from "@t4code/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type TauriEventHandler = (event: { payload: unknown }) => void;

const { showContextMenuFallbackMock, startBrowserSurfaceSyncMock } = vi.hoisted(() => ({
  showContextMenuFallbackMock: vi.fn(),
  startBrowserSurfaceSyncMock: vi.fn(),
}));

vi.mock("./browser/browserSurfaceSync", () => ({
  startBrowserSurfaceSync: startBrowserSurfaceSyncMock,
}));

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

const unsupportedSshError = {
  code: "tauri_capability_unsupported",
  method: "ensureSshEnvironment",
  capability: "sshProvisioning",
  message: "ensureSshEnvironment requires sshProvisioning, which is temporarily unavailable.",
};

const unsupportedContextMenuError = {
  code: "tauri_capability_unsupported",
  method: "showContextMenu",
  capability: "nativeContextMenu",
  message: "showContextMenu requires nativeContextMenu, which is temporarily unavailable.",
};

const defaultLocalEnvironmentBootstrap = {
  id: "primary",
  label: "Local",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
  bootstrapToken: "bootstrap-token",
};

function installTauriHarness(options?: {
  readonly previewSupported?: boolean;
  readonly rejectMetadata?: boolean;
  readonly contextMenuResult?: string | null;
  readonly rejectContextMenu?: unknown;
  readonly rejectSshProvisioning?: boolean;
  readonly localEnvironmentBootstraps?: readonly unknown[] | (() => readonly unknown[]);
  readonly rejectFallbackCommands?: boolean;
  readonly rejectListeners?: boolean;
}) {
  const listeners = new Map<string, TauriEventHandler>();
  const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();

  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "desktop_bridge_get_bridge_metadata":
        if (options?.rejectMetadata) {
          return Promise.reject(new Error("bridge metadata unavailable"));
        }
        return Promise.resolve({
          host: "tauri",
          bridgeVersion: 1,
          features: {
            localBackend: true,
            localBearerToken: true,
            clientSettings: true,
            serverExposure: true,
            wslDiscovery: true,
            sshRemoteHttp: true,
            connectionCatalog: true,
            preview: options?.previewSupported ?? false,
            updater: false,
            menuEvents: true,
            sshProvisioning: true,
          },
        });
      case "desktop_bridge_check_for_update":
        return Promise.resolve({
          checked: false,
          state: { status: "disabled", channel: "latest" },
        });
      case "desktop_bridge_download_update":
        return Promise.resolve({
          accepted: false,
          completed: false,
          state: { status: "disabled", channel: "latest" },
        });
      case "desktop_bridge_install_update":
        return Promise.resolve({
          accepted: false,
          completed: false,
          state: { status: "disabled", channel: "latest" },
        });
      case "desktop_bridge_save_diagnostic_logs":
        return Promise.resolve("C:\\Users\\test\\Downloads\\diagnostics.zip");
      case "desktop_bridge_ensure_ssh_environment":
        if (options?.rejectSshProvisioning) {
          return Promise.reject(unsupportedSshError);
        }
        return Promise.resolve({
          target: args?.target,
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          pairingToken: "ssh-pairing-token",
          remotePort: 3773,
          remoteServerKind: "managed",
        });
      case "desktop_bridge_show_context_menu":
        if ("rejectContextMenu" in (options ?? {})) {
          return Promise.reject(options?.rejectContextMenu);
        }
        return Promise.resolve(options?.contextMenuResult ?? null);
      case "desktop_bridge_get_local_environment_bootstraps":
        return Promise.resolve(
          typeof options?.localEnvironmentBootstraps === "function"
            ? options.localEnvironmentBootstraps()
            : (options?.localEnvironmentBootstraps ?? [defaultLocalEnvironmentBootstrap]),
        );
      case "desktop_bridge_get_connection_catalog":
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error("native catalog unavailable"))
          : Promise.resolve("native-catalog");
      case "desktop_bridge_set_connection_catalog":
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error("native catalog unavailable"))
          : Promise.resolve(args?.catalog === "saved-catalog");
      case "desktop_bridge_clear_connection_catalog":
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error("native catalog unavailable"))
          : Promise.resolve(undefined);
      case "desktop_bridge_fetch_environment_descriptor":
        return Promise.resolve({ environmentId: "ssh-env" });
      case "desktop_bridge_bootstrap_ssh_bearer_session":
        return Promise.resolve({ access_token: "ssh-bearer" });
      case "desktop_bridge_fetch_ssh_session_state":
        return Promise.resolve({ authenticated: true });
      case "desktop_bridge_issue_ssh_web_socket_ticket":
        return Promise.resolve({ ticket: "ws-ticket" });
      default:
        return options?.rejectFallbackCommands
          ? Promise.reject(new Error(`unsupported fallback command: ${command}`))
          : Promise.resolve(null);
    }
  });

  const listen = vi.fn(async (event: string, handler: TauriEventHandler) => {
    if (options?.rejectListeners) {
      throw new Error(`listener unavailable: ${event}`);
    }
    listeners.set(event, handler);
    const unlisten = vi.fn(() => {
      listeners.delete(event);
    });
    unlisteners.set(event, unlisten);
    return unlisten;
  });

  vi.stubGlobal("window", {
    __TAURI__: {
      core: { invoke },
      event: { listen },
    },
    desktopBridge: undefined,
  });

  return { invoke, listen, listeners, unlisteners };
}

async function installBridge(): Promise<DesktopBridge> {
  const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
  await tauriDesktopBridgeReady;
  const bridge = window.desktopBridge;
  if (!bridge) {
    throw new Error("Expected Tauri adapter to install window.desktopBridge.");
  }
  return bridge;
}

describe("tauriDesktopBridge", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    showContextMenuFallbackMock.mockReset();
    startBrowserSurfaceSyncMock.mockReset();
  });

  it("starts browser surface sync once when installing the Tauri preview bridge", async () => {
    installTauriHarness({ previewSupported: true });

    const bridge = await installBridge();
    await import("./tauriDesktopBridge");

    expect(startBrowserSurfaceSyncMock).toHaveBeenCalledTimes(1);
    expect(startBrowserSurfaceSyncMock).toHaveBeenCalledWith(bridge.preview);
  });

  it("omits the preview bridge when the native host reports it unsupported", async () => {
    installTauriHarness({ previewSupported: false });

    const bridge = await installBridge();

    expect(bridge.preview).toBeUndefined();
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("fails closed when native preview support cannot be determined", async () => {
    installTauriHarness({ rejectMetadata: true });

    const bridge = await installBridge();

    expect(bridge.preview).toBeUndefined();
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("does not start browser surface sync in a browser runtime", async () => {
    vi.stubGlobal("window", { desktopBridge: undefined });

    const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
    await tauriDesktopBridgeReady;

    expect(window.desktopBridge).toBeUndefined();
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("does not start browser surface sync when a desktop bridge already exists", async () => {
    installTauriHarness();
    const existingBridge = { preview: { setBounds: vi.fn() } } as unknown as DesktopBridge;
    window.desktopBridge = existingBridge;

    const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
    await tauriDesktopBridgeReady;

    expect(window.desktopBridge).toBe(existingBridge);
    expect(startBrowserSurfaceSyncMock).not.toHaveBeenCalled();
  });

  it("waits for the primary bootstrap before reporting the Tauri bridge ready", async () => {
    let reads = 0;
    const primaryBootstrap = {
      id: "primary",
      label: "Local",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "bootstrap-token",
    };
    installTauriHarness({
      localEnvironmentBootstraps: () => (++reads === 1 ? [] : [primaryBootstrap]),
    });

    const { tauriDesktopBridgeReady } = await import("./tauriDesktopBridge");
    await tauriDesktopBridgeReady;

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(window.desktopBridge?.getLocalEnvironmentBootstraps()).toEqual([primaryBootstrap]);
  });

  it("routes SSH remote API helpers through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(bridge.fetchSshEnvironmentDescriptor("http://127.0.0.1:3773")).resolves.toEqual({
      environmentId: "ssh-env",
    });
    await expect(
      bridge.bootstrapSshBearerSession("http://127.0.0.1:3773", "pairing-token"),
    ).resolves.toEqual({ access_token: "ssh-bearer" });
    await expect(
      bridge.fetchSshSessionState("http://127.0.0.1:3773", "bearer-token"),
    ).resolves.toEqual({ authenticated: true });
    await expect(
      bridge.issueSshWebSocketTicket("http://127.0.0.1:3773", "bearer-token"),
    ).resolves.toEqual({ ticket: "ws-ticket" });

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_fetch_environment_descriptor", {
      httpBaseUrl: "http://127.0.0.1:3773",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_bootstrap_ssh_bearer_session", {
      httpBaseUrl: "http://127.0.0.1:3773",
      credential: "pairing-token",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_fetch_ssh_session_state", {
      httpBaseUrl: "http://127.0.0.1:3773",
      bearerToken: "bearer-token",
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_issue_ssh_web_socket_ticket", {
      httpBaseUrl: "http://127.0.0.1:3773",
      bearerToken: "bearer-token",
    });
  });

  it("exposes Tauri bridge metadata and structured unsupported errors", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(bridge.getHostMetadata?.()).resolves.toEqual({
      host: "tauri",
      bridgeVersion: 1,
      features: {
        localBackend: true,
        localBearerToken: true,
        clientSettings: true,
        serverExposure: true,
        wslDiscovery: true,
        sshRemoteHttp: true,
        connectionCatalog: true,
        preview: false,
        updater: false,
        menuEvents: true,
        sshProvisioning: true,
      },
    });
    const branding = bridge.getAppBranding();
    expect(branding?.baseName).toBe("T4Code");
    expect(["Alpha", "Dev", "Nightly"]).toContain(branding?.stageLabel);
    expect(branding?.displayName).toBe(`T4Code (${branding?.stageLabel})`);

    await expect(
      bridge.ensureSshEnvironment({
        alias: "host-1",
        hostname: "example.test",
        username: null,
        port: null,
      }),
    ).resolves.toEqual({
      target: {
        alias: "host-1",
        hostname: "example.test",
        username: null,
        port: null,
      },
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      pairingToken: "ssh-pairing-token",
      remotePort: 3773,
      remoteServerKind: "managed",
    });

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_bridge_metadata", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_ensure_ssh_environment", {
      target: {
        alias: "host-1",
        hostname: "example.test",
        username: null,
        port: null,
      },
      options: undefined,
    });
  });

  it("routes connection catalog persistence through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    expect(bridge.getConnectionCatalog).toBeDefined();
    expect(bridge.setConnectionCatalog).toBeDefined();
    expect(bridge.clearConnectionCatalog).toBeDefined();

    await expect(bridge.getConnectionCatalog!()).resolves.toBe("native-catalog");
    await expect(bridge.setConnectionCatalog!("saved-catalog")).resolves.toBe(true);
    await expect(bridge.clearConnectionCatalog!()).resolves.toBeUndefined();

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_connection_catalog", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_set_connection_catalog", {
      catalog: "saved-catalog",
    });
    expect(harness.invoke).toHaveBeenCalledWith(
      "desktop_bridge_clear_connection_catalog",
      undefined,
    );
  });

  it("normalizes structured unsupported errors returned by Tauri commands", async () => {
    installTauriHarness({ rejectSshProvisioning: true });
    const bridge = await installBridge();

    await expect(
      bridge.ensureSshEnvironment({
        alias: "host-2",
        hostname: "example.test",
        username: null,
        port: null,
      }),
    ).rejects.toMatchObject({
      name: "TauriDesktopCapabilityUnsupportedError",
      code: "tauri_capability_unsupported",
      method: "ensureSshEnvironment",
      capability: "sshProvisioning",
    });
  });

  it("routes context menus through the Tauri host command", async () => {
    const harness = installTauriHarness({ contextMenuResult: "open" });
    const bridge = await installBridge();
    const items = [{ id: "open", label: "Open" }] as const;

    await expect(bridge.showContextMenu(items, { x: 10, y: 20 })).resolves.toBe("open");

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_show_context_menu", {
      items,
      position: { x: 10, y: 20 },
    });
    expect(showContextMenuFallbackMock).not.toHaveBeenCalled();
  });

  it("falls back to the web context menu when Tauri reports native context menus unsupported", async () => {
    const harness = installTauriHarness({ rejectContextMenu: unsupportedContextMenuError });
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const bridge = await installBridge();
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(bridge.showContextMenu(items, { x: 30, y: 40 })).resolves.toBe("rename");

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_show_context_menu", {
      items,
      position: { x: 30, y: 40 },
    });
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 30, y: 40 });
  });

  it("does not hide unexpected Tauri context menu errors behind the web fallback", async () => {
    const hostError = new Error("native menu crashed");
    installTauriHarness({ rejectContextMenu: hostError });
    const bridge = await installBridge();

    await expect(bridge.showContextMenu([{ id: "open", label: "Open" }])).rejects.toBe(hostError);
    expect(showContextMenuFallbackMock).not.toHaveBeenCalled();
  });

  it("returns disabled updater results through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(bridge.checkForUpdate()).resolves.toEqual({
      checked: false,
      state: { status: "disabled", channel: "latest" },
    });
    await expect(bridge.downloadUpdate()).resolves.toEqual({
      accepted: false,
      completed: false,
      state: { status: "disabled", channel: "latest" },
    });
    await expect(bridge.installUpdate()).resolves.toEqual({
      accepted: false,
      completed: false,
      state: { status: "disabled", channel: "latest" },
    });

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_check_for_update", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_download_update", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_install_update", undefined);
  });

  it("saves diagnostic archives through the Tauri host", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();

    await expect(
      bridge.saveDiagnosticLogs?.("diagnostics.zip", new Uint8Array([0x50, 0x4b])),
    ).resolves.toBe("C:\\Users\\test\\Downloads\\diagnostics.zip");
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_save_diagnostic_logs", {
      filename: "diagnostics.zip",
      bytes: [0x50, 0x4b],
    });
  });

  it("routes the remaining desktop bridge capabilities through Tauri commands", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const sshTarget = {
      alias: "host-1",
      hostname: "example.test",
      username: null,
      port: null,
    };

    await expect(bridge.getClientSettings()).resolves.toBeNull();
    await expect(bridge.setClientSettings({} as never)).resolves.toBeNull();
    await expect(bridge.discoverSshHosts()).resolves.toBeNull();
    await expect(bridge.disconnectSshEnvironment(sshTarget)).resolves.toBeNull();
    await expect(bridge.resolveSshPasswordPrompt?.("request-1", "secret")).resolves.toBeNull();
    await expect(bridge.getServerExposureState()).resolves.toBeNull();
    await expect(bridge.setServerExposureMode("network-accessible")).resolves.toBeNull();
    await expect(
      bridge.setTailscaleServeEnabled({ enabled: true, port: 8443 }),
    ).resolves.toBeNull();
    await expect(bridge.getAdvertisedEndpoints()).resolves.toBeNull();
    await expect(bridge.getWslState()).resolves.toBeNull();
    await expect(bridge.setWslBackendEnabled(true)).resolves.toBeNull();
    await expect(bridge.setWslDistro("Ubuntu")).resolves.toBeNull();
    await expect(bridge.setWslOnly(true)).resolves.toBeNull();
    await expect(bridge.pickFolder({ initialPath: "/workspace" })).resolves.toBeNull();
    await expect(bridge.confirm("Continue?")).resolves.toBeNull();
    await expect(bridge.setTheme("dark")).resolves.toBeNull();
    await expect(bridge.openExternal("https://example.test")).resolves.toBeNull();
    await expect(bridge.getUpdateState()).resolves.toBeNull();
    await expect(bridge.setUpdateChannel("nightly")).resolves.toBeNull();

    const passwordRequests: unknown[] = [];
    const disposePasswordPrompt = bridge.onSshPasswordPrompt?.((request) =>
      passwordRequests.push(request),
    );
    await Promise.resolve();
    harness.listeners.get("desktop:ssh-password-prompt")?.({
      payload: { requestId: "request-1", prompt: "Password" },
    });
    expect(passwordRequests).toEqual([{ requestId: "request-1", prompt: "Password" }]);
    disposePasswordPrompt?.();

    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_client_settings", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_discover_ssh_hosts", undefined);
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_disconnect_ssh_environment", {
      target: sshTarget,
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_set_wsl_backend_enabled", {
      enabled: true,
    });
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_set_update_channel", {
      channel: "nightly",
    });
  });

  it("wraps Tauri event listeners and tears them down", async () => {
    const harness = installTauriHarness();
    const bridge = await installBridge();
    const menuActions: string[] = [];
    const updateStates: unknown[] = [];

    const disposeMenu = bridge.onMenuAction((action) => menuActions.push(action));
    const disposeUpdate = bridge.onUpdateState((state) => updateStates.push(state));
    await Promise.resolve();

    expect(harness.listen).toHaveBeenCalledWith("desktop:menu-action", expect.any(Function));
    expect(harness.listen).toHaveBeenCalledWith("desktop:update-state", expect.any(Function));

    harness.listeners.get("desktop:menu-action")?.({ payload: "open-settings" });
    harness.listeners.get("desktop:update-state")?.({
      payload: { status: "checking" },
    });

    expect(menuActions).toEqual(["open-settings"]);
    expect(updateStates).toEqual([{ status: "checking" }]);

    disposeMenu();
    disposeUpdate();
    await Promise.resolve();

    expect(harness.unlisteners.get("desktop:menu-action")).toHaveBeenCalledTimes(1);
    expect(harness.unlisteners.get("desktop:update-state")).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached local bootstraps and bearer tokens from backend-ready events without reinstalling the bridge", async () => {
    const harness = installTauriHarness({
      localEnvironmentBootstraps: [
        {
          id: "primary",
          label: "Local",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
          bootstrapToken: "bootstrap-token-1",
        },
      ],
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const subjectToken = body.get("subject_token");
      return {
        ok: true,
        json: async () => ({ access_token: `bearer-for-${subjectToken}` }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const bridge = await installBridge();
    await Promise.resolve();

    expect(harness.listen).toHaveBeenCalledWith("desktop:backend-ready", expect.any(Function));
    expect(await bridge.getLocalEnvironmentBearerToken()).toBe("bearer-for-bootstrap-token-1");
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([
      {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
        bootstrapToken: "bootstrap-token-1",
      },
    ]);

    const originalBridge = window.desktopBridge;
    harness.listeners.get("desktop:backend-ready")?.({
      payload: {
        reason: "restarted",
        bootstraps: [
          {
            id: "primary",
            label: "Local",
            httpBaseUrl: "http://127.0.0.1:4888",
            wsBaseUrl: "ws://127.0.0.1:4888",
            bootstrapToken: "bootstrap-token-2",
          },
        ],
      },
    });

    expect(window.desktopBridge).toBe(originalBridge);
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([
      {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:4888",
        wsBaseUrl: "ws://127.0.0.1:4888",
        bootstrapToken: "bootstrap-token-2",
      },
    ]);
    expect(await bridge.getLocalEnvironmentBearerToken()).toBe("bearer-for-bootstrap-token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses browser fallbacks when optional native capabilities reject", async () => {
    const storage = new Map<string, string>([["t4code.connectionCatalog", "legacy-catalog"]]);
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    const harness = installTauriHarness({ rejectFallbackCommands: true });
    Object.assign(window, {
      confirm: vi.fn(() => true),
      open: vi.fn(),
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);
    const bridge = await installBridge();

    await expect(bridge.getClientSettings()).resolves.toBeNull();
    await expect(bridge.setClientSettings(DEFAULT_CLIENT_SETTINGS)).resolves.toBeUndefined();
    await expect(bridge.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await expect(bridge.getConnectionCatalog!()).resolves.toBe("legacy-catalog");
    await expect(bridge.setConnectionCatalog!("browser-catalog")).resolves.toBe(true);
    await expect(bridge.clearConnectionCatalog!()).resolves.toBeUndefined();
    await expect(bridge.discoverSshHosts()).resolves.toEqual([]);
    await expect(
      bridge.disconnectSshEnvironment({
        alias: "fallback",
        hostname: "fallback.test",
        username: null,
        port: null,
      }),
    ).resolves.toBeUndefined();
    await expect(bridge.getAdvertisedEndpoints()).resolves.toEqual([]);
    await expect(bridge.pickFolder()).resolves.toBeNull();
    await expect(bridge.confirm("Continue?")).resolves.toBe(true);
    await expect(bridge.setTheme("dark")).resolves.toBeUndefined();
    await expect(bridge.openExternal("https://example.test/path")).resolves.toBe(true);
    await expect(bridge.openExternal("file:///tmp/secret")).resolves.toBe(false);
    await expect(bridge.openExternal("not a URL")).resolves.toBe(false);

    await expect(bridge.getServerExposureState()).resolves.toMatchObject({ mode: "local-only" });
    await expect(bridge.setServerExposureMode("network-accessible")).resolves.toMatchObject({
      mode: "local-only",
    });
    await expect(
      bridge.setTailscaleServeEnabled({ enabled: true, port: 8443 }),
    ).resolves.toMatchObject({ tailscaleServeEnabled: false });
    await expect(bridge.getWslState()).resolves.toMatchObject({ enabled: false, distros: [] });
    await expect(bridge.setWslBackendEnabled(true)).resolves.toMatchObject({ enabled: false });
    await expect(bridge.setWslDistro("Ubuntu")).resolves.toMatchObject({ distro: null });
    await expect(bridge.setWslOnly(true)).resolves.toMatchObject({ wslOnly: false });
    await expect(bridge.getUpdateState()).resolves.toMatchObject({ status: "disabled" });
    await expect(bridge.setUpdateChannel("nightly")).resolves.toMatchObject({
      channel: "nightly",
    });

    expect(window.open).toHaveBeenCalledWith(
      "https://example.test/path",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "t4code.connectionCatalog",
      "browser-catalog",
    );
    expect(localStorage.removeItem).toHaveBeenCalled();
    expect(harness.invoke).toHaveBeenCalledWith("desktop_bridge_get_update_state", undefined);
  });

  it("fails closed when browser catalog storage and event subscription are unavailable", async () => {
    const localStorage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      removeItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
    };
    installTauriHarness({ rejectFallbackCommands: true, rejectListeners: true });
    Object.assign(window, { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    const bridge = await installBridge();

    await expect(bridge.getConnectionCatalog!()).resolves.toBeNull();
    await expect(bridge.setConnectionCatalog!("catalog")).resolves.toBe(false);
    await expect(bridge.clearConnectionCatalog!()).resolves.toBeUndefined();
    const dispose = bridge.onMenuAction(() => {
      throw new Error("listener must stay inactive");
    });
    dispose();
    await Promise.resolve();

    expect(localStorage.getItem).toHaveBeenCalled();
    expect(localStorage.setItem).toHaveBeenCalled();
    expect(localStorage.removeItem).toHaveBeenCalled();
  });

  it("retries bearer-token exchange after HTTP and payload failures", async () => {
    installTauriHarness();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "recovered" }) });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await installBridge();

    await expect(bridge.getLocalEnvironmentBearerToken()).rejects.toThrowError(/failed: 503/u);
    await expect(bridge.getLocalEnvironmentBearerToken()).rejects.toThrowError(
      /did not include a token/u,
    );
    await expect(bridge.getLocalEnvironmentBearerToken()).resolves.toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
