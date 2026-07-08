import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

type AnyFn = (...args: ReadonlyArray<unknown>) => unknown;

const state = vi.hoisted(() => ({
  exposed: null as { key: string; api: Record<string, unknown> } | null,
  invoke: vi.fn((_channel: string, ..._args: ReadonlyArray<unknown>) =>
    Promise.resolve(undefined as unknown),
  ),
  sendSync: vi.fn((_channel: string, ..._args: ReadonlyArray<unknown>) => undefined as unknown),
  on: vi.fn((_channel: string, _listener: AnyFn) => {}),
  removeListener: vi.fn((_channel: string, _listener: AnyFn) => {}),
}));

const clerkState = vi.hoisted(() => ({ exposeClerkBridge: vi.fn() }));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
      state.exposed = { key, api };
    },
  },
  ipcRenderer: {
    invoke: state.invoke,
    sendSync: state.sendSync,
    on: state.on,
    removeListener: state.removeListener,
  },
}));

vi.mock("@clerk/electron/preload", () => ({
  exposeClerkBridge: clerkState.exposeClerkBridge,
}));

// The bridge object the preload script exposes on the main world.
// Typed loosely so the test can drive every method without fighting the
// DesktopBridge signature.
type Bridge = Record<string, any>;

const bridge = (): Bridge => {
  if (state.exposed === null) throw new Error("desktopBridge was never exposed");
  return state.exposed.api as Bridge;
};

// Latest wrapped listener the preload registered against a channel via
// ipcRenderer.on — this is the internal function that guards payloads.
const lastWrappedListener = (channel: string): AnyFn => {
  const calls = state.on.mock.calls.filter(([registered]) => registered === channel);
  const last = calls.at(-1);
  if (!last) throw new Error(`no ipcRenderer.on registration for ${channel}`);
  return last[1] as AnyFn;
};

// The last args (excluding the channel) sent through ipcRenderer.invoke for a channel.
const lastInvoke = (channel: string): ReadonlyArray<unknown> => {
  const calls = state.invoke.mock.calls.filter(([registered]) => registered === channel);
  const last = calls.at(-1);
  if (!last) throw new Error(`no ipcRenderer.invoke for ${channel}`);
  return last.slice(1);
};

describe("preload desktopBridge", () => {
  beforeAll(async () => {
    await import("./preload.ts");
  });

  beforeEach(() => {
    state.invoke.mockClear();
    state.sendSync.mockClear();
    state.on.mockClear();
    state.removeListener.mockClear();
    state.invoke.mockImplementation(() => Promise.resolve(undefined));
    state.sendSync.mockImplementation(() => undefined);
  });

  it("exposes the Clerk bridge with passkeys and the desktop bridge on the main world", () => {
    expect(clerkState.exposeClerkBridge).toHaveBeenCalledWith({ passkeys: true });
    expect(state.exposed?.key).toBe("desktopBridge");
    expect(typeof bridge().getAppBranding).toBe("function");
  });

  describe("getAppBranding", () => {
    it("returns the branding object when the sync IPC yields an object", () => {
      const branding = { productName: "T4Code" };
      state.sendSync.mockReturnValueOnce(branding);
      expect(bridge().getAppBranding()).toBe(branding);
      expect(state.sendSync).toHaveBeenCalledWith(IpcChannels.GET_APP_BRANDING_CHANNEL);
    });

    it("returns null when the sync IPC yields a non-object", () => {
      state.sendSync.mockReturnValueOnce("not-an-object");
      expect(bridge().getAppBranding()).toBeNull();
    });

    it("returns null when the sync IPC yields null", () => {
      state.sendSync.mockReturnValueOnce(null);
      expect(bridge().getAppBranding()).toBeNull();
    });
  });

  describe("getLocalEnvironmentBootstraps", () => {
    it("returns the array when the sync IPC yields an array", () => {
      const bootstraps = [{ id: "a" }, { id: "b" }];
      state.sendSync.mockReturnValueOnce(bootstraps);
      expect(bridge().getLocalEnvironmentBootstraps()).toBe(bootstraps);
      expect(state.sendSync).toHaveBeenCalledWith(
        IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
      );
    });

    it("returns an empty array when the sync IPC yields a non-array", () => {
      state.sendSync.mockReturnValueOnce({ not: "array" });
      expect(bridge().getLocalEnvironmentBootstraps()).toEqual([]);
    });
  });

  describe("simple invoke passthroughs", () => {
    it("forwards no-argument invoke methods to their channels", () => {
      bridge().getLocalEnvironmentBearerToken();
      expect(lastInvoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL)).toEqual([]);

      bridge().getClientSettings();
      expect(lastInvoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL)).toEqual([]);

      bridge().getConnectionCatalog();
      expect(lastInvoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL)).toEqual([]);

      bridge().clearConnectionCatalog();
      expect(lastInvoke(IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL)).toEqual([]);

      bridge().discoverSshHosts();
      expect(lastInvoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL)).toEqual([]);

      bridge().getServerExposureState();
      expect(lastInvoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL)).toEqual([]);

      bridge().getAdvertisedEndpoints();
      expect(lastInvoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL)).toEqual([]);

      bridge().getWslState();
      expect(lastInvoke(IpcChannels.GET_WSL_STATE_CHANNEL)).toEqual([]);

      bridge().getUpdateState();
      expect(lastInvoke(IpcChannels.UPDATE_GET_STATE_CHANNEL)).toEqual([]);

      bridge().checkForUpdate();
      expect(lastInvoke(IpcChannels.UPDATE_CHECK_CHANNEL)).toEqual([]);

      bridge().downloadUpdate();
      expect(lastInvoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL)).toEqual([]);

      bridge().installUpdate();
      expect(lastInvoke(IpcChannels.UPDATE_INSTALL_CHANNEL)).toEqual([]);
    });

    it("forwards single-argument invoke methods with their payloads", () => {
      bridge().setClientSettings({ theme: "dark" });
      expect(lastInvoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL)).toEqual([{ theme: "dark" }]);

      bridge().setConnectionCatalog({ hosts: [] });
      expect(lastInvoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL)).toEqual([{ hosts: [] }]);

      bridge().disconnectSshEnvironment("host-a");
      expect(lastInvoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL)).toEqual(["host-a"]);

      bridge().setServerExposureMode("network-accessible");
      expect(lastInvoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL)).toEqual([
        "network-accessible",
      ]);

      bridge().setTailscaleServeEnabled({ enabled: true });
      expect(lastInvoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL)).toEqual([
        { enabled: true },
      ]);

      bridge().setWslBackendEnabled(true);
      expect(lastInvoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL)).toEqual([true]);

      bridge().setWslDistro("Ubuntu");
      expect(lastInvoke(IpcChannels.SET_WSL_DISTRO_CHANNEL)).toEqual(["Ubuntu"]);

      bridge().setWslOnly(false);
      expect(lastInvoke(IpcChannels.SET_WSL_ONLY_CHANNEL)).toEqual([false]);

      bridge().pickFolder({ title: "pick" });
      expect(lastInvoke(IpcChannels.PICK_FOLDER_CHANNEL)).toEqual([{ title: "pick" }]);

      bridge().confirm("Are you sure?");
      expect(lastInvoke(IpcChannels.CONFIRM_CHANNEL)).toEqual(["Are you sure?"]);

      bridge().setTheme("dark");
      expect(lastInvoke(IpcChannels.SET_THEME_CHANNEL)).toEqual(["dark"]);

      bridge().openExternal("https://example.com");
      expect(lastInvoke(IpcChannels.OPEN_EXTERNAL_CHANNEL)).toEqual(["https://example.com"]);

      bridge().setUpdateChannel("nightly");
      expect(lastInvoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL)).toEqual(["nightly"]);
    });

    it("forwards ssh descriptor and session helpers with structured payloads", () => {
      bridge().fetchSshEnvironmentDescriptor("http://base");
      expect(lastInvoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL)).toEqual([
        { httpBaseUrl: "http://base" },
      ]);

      bridge().bootstrapSshBearerSession("http://base", { token: "t" });
      expect(lastInvoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL)).toEqual([
        { httpBaseUrl: "http://base", credential: { token: "t" } },
      ]);

      bridge().fetchSshSessionState("http://base", "bearer");
      expect(lastInvoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL)).toEqual([
        { httpBaseUrl: "http://base", bearerToken: "bearer" },
      ]);

      bridge().issueSshWebSocketTicket("http://base", "bearer");
      expect(lastInvoke(IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL)).toEqual([
        { httpBaseUrl: "http://base", bearerToken: "bearer" },
      ]);

      bridge().resolveSshPasswordPrompt("req-1", "hunter2");
      expect(lastInvoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL)).toEqual([
        { requestId: "req-1", password: "hunter2" },
      ]);
    });
  });

  describe("showContextMenu", () => {
    it("omits the position field when no position is given", () => {
      bridge().showContextMenu([{ label: "Copy" }]);
      expect(lastInvoke(IpcChannels.CONTEXT_MENU_CHANNEL)).toEqual([
        { items: [{ label: "Copy" }] },
      ]);
    });

    it("includes the position field when a position is given", () => {
      bridge().showContextMenu([{ label: "Copy" }], { x: 10, y: 20 });
      expect(lastInvoke(IpcChannels.CONTEXT_MENU_CHANNEL)).toEqual([
        { items: [{ label: "Copy" }], position: { x: 10, y: 20 } },
      ]);
    });
  });

  describe("ensureSshEnvironment", () => {
    it("passes only the target when options are omitted", async () => {
      state.invoke.mockResolvedValueOnce({ ok: true });
      const result = await bridge().ensureSshEnvironment("host-a");
      expect(result).toEqual({ ok: true });
      expect(lastInvoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL)).toEqual([
        { target: "host-a" },
      ]);
    });

    it("passes target and options when options are provided", async () => {
      state.invoke.mockResolvedValueOnce({ ok: true });
      await bridge().ensureSshEnvironment("host-a", { force: true });
      expect(lastInvoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL)).toEqual([
        { target: "host-a", options: { force: true } },
      ]);
    });

    it("throws the provided message when the prompt was cancelled", async () => {
      state.invoke.mockResolvedValueOnce({
        type: IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
        message: "User cancelled the prompt",
      });
      await expect(bridge().ensureSshEnvironment("host-a")).rejects.toThrow(
        "User cancelled the prompt",
      );
    });

    it("throws a default message when the cancelled result has no message", async () => {
      state.invoke.mockResolvedValueOnce({
        type: IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
      });
      await expect(bridge().ensureSshEnvironment("host-a")).rejects.toThrow(
        "SSH authentication cancelled.",
      );
    });

    it("throws a default message when the cancelled result message is not a string", async () => {
      state.invoke.mockResolvedValueOnce({
        type: IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
        message: 42,
      });
      await expect(bridge().ensureSshEnvironment("host-a")).rejects.toThrow(
        "SSH authentication cancelled.",
      );
    });
  });

  describe("listener registration and payload guards", () => {
    it("onMenuAction forwards string actions, ignores non-strings, and unsubscribes", () => {
      const listener = vi.fn();
      const unsubscribe = bridge().onMenuAction(listener);
      const wrapped = lastWrappedListener(IpcChannels.MENU_ACTION_CHANNEL);

      wrapped({}, "focus-input");
      expect(listener).toHaveBeenCalledWith("focus-input");

      wrapped({}, 123);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      expect(state.removeListener).toHaveBeenCalledWith(IpcChannels.MENU_ACTION_CHANNEL, wrapped);
    });

    it("onSshPasswordPrompt forwards object requests, ignores non-objects, and unsubscribes", () => {
      const listener = vi.fn();
      const unsubscribe = bridge().onSshPasswordPrompt(listener);
      const wrapped = lastWrappedListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL);

      const request = { requestId: "r1" };
      wrapped({}, request);
      expect(listener).toHaveBeenCalledWith(request);

      wrapped({}, null);
      wrapped({}, "nope");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      expect(state.removeListener).toHaveBeenCalledWith(
        IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL,
        wrapped,
      );
    });

    it("onUpdateState forwards object states, ignores non-objects, and unsubscribes", () => {
      const listener = vi.fn();
      const unsubscribe = bridge().onUpdateState(listener);
      const wrapped = lastWrappedListener(IpcChannels.UPDATE_STATE_CHANNEL);

      const updateState = { status: "idle" };
      wrapped({}, updateState);
      expect(listener).toHaveBeenCalledWith(updateState);

      wrapped({}, null);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      expect(state.removeListener).toHaveBeenCalledWith(IpcChannels.UPDATE_STATE_CHANNEL, wrapped);
    });
  });

  describe("preview bridge", () => {
    it("forwards tab-scoped preview commands", () => {
      const preview = bridge().preview;

      preview.createTab("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.closeTab("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.registerWebview("tab-1", 42);
      expect(lastInvoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL)).toEqual([
        { tabId: "tab-1", webContentsId: 42 },
      ]);

      preview.navigate("tab-1", "https://example.com");
      expect(lastInvoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL)).toEqual([
        { tabId: "tab-1", url: "https://example.com" },
      ]);

      preview.goBack("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.goForward("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.refresh("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_REFRESH_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.zoomIn("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.zoomOut("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.resetZoom("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.hardReload("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.openDevTools("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.pickElement("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      preview.cancelPickElement("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL)).toEqual([
        { tabId: "tab-1" },
      ]);

      preview.captureScreenshot("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL)).toEqual([
        { tabId: "tab-1" },
      ]);
    });

    it("forwards cache, config, artifact, and annotation commands", () => {
      const preview = bridge().preview;

      preview.clearCookies();
      expect(lastInvoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL)).toEqual([]);

      preview.clearCache();
      expect(lastInvoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL)).toEqual([]);

      preview.getPreviewConfig("env-1");
      expect(lastInvoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL)).toEqual([
        { environmentId: "env-1" },
      ]);

      preview.setAnnotationTheme({ colorScheme: "dark" });
      expect(lastInvoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL)).toEqual([
        { theme: { colorScheme: "dark" } },
      ]);

      preview.revealArtifact("/tmp/a.png");
      expect(lastInvoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL)).toEqual([
        { path: "/tmp/a.png" },
      ]);

      preview.copyArtifactToClipboard("/tmp/a.png");
      expect(lastInvoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL)).toEqual([
        { path: "/tmp/a.png" },
      ]);
    });

    it("forwards recording commands and guards frame payloads", () => {
      const recording = bridge().preview.recording;

      recording.startScreencast("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      recording.stopScreencast("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL)).toEqual([{ tabId: "tab-1" }]);

      recording.save("tab-1", "video/webm", new Uint8Array([1, 2, 3]));
      const saveArgs = lastInvoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL)[0] as {
        tabId: string;
        mimeType: string;
      };
      expect(saveArgs.tabId).toBe("tab-1");
      expect(saveArgs.mimeType).toBe("video/webm");

      const listener = vi.fn();
      const unsubscribe = recording.onFrame(listener);
      const wrapped = lastWrappedListener(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL);

      const frame = { tabId: "tab-1", data: "x" };
      wrapped({}, frame);
      expect(listener).toHaveBeenCalledWith(frame);

      wrapped({}, null);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      expect(state.removeListener).toHaveBeenCalledWith(
        IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL,
        wrapped,
      );
    });

    it("forwards automation commands", () => {
      const automation = bridge().preview.automation;

      automation.status("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL)).toEqual([
        { tabId: "tab-1" },
      ]);

      automation.snapshot("tab-1");
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL)).toEqual([
        { tabId: "tab-1" },
      ]);

      automation.click("tab-1", { selector: "#a" });
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL)).toEqual([
        { tabId: "tab-1", input: { selector: "#a" } },
      ]);

      automation.type("tab-1", { text: "hi" });
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL)).toEqual([
        { tabId: "tab-1", input: { text: "hi" } },
      ]);

      automation.press("tab-1", { key: "Enter" });
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL)).toEqual([
        { tabId: "tab-1", input: { key: "Enter" } },
      ]);

      automation.scroll("tab-1", { y: 10 });
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL)).toEqual([
        { tabId: "tab-1", input: { y: 10 } },
      ]);

      automation.evaluate("tab-1", { expression: "1+1" });
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL)).toEqual([
        { tabId: "tab-1", input: { expression: "1+1" } },
      ]);

      automation.waitFor("tab-1", { selector: "#b" });
      expect(lastInvoke(IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL)).toEqual([
        { tabId: "tab-1", input: { selector: "#b" } },
      ]);
    });

    it("onStateChange forwards valid tab states and guards invalid payloads", () => {
      const listener = vi.fn();
      const unsubscribe = bridge().preview.onStateChange(listener);
      const wrapped = lastWrappedListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL);

      const tabState = { url: "https://example.com" };
      wrapped({}, "tab-1", tabState);
      expect(listener).toHaveBeenCalledWith("tab-1", tabState);

      wrapped({}, 123, tabState);
      wrapped({}, "tab-1", null);
      wrapped({}, "tab-1", "not-object");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      expect(state.removeListener).toHaveBeenCalledWith(
        IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL,
        wrapped,
      );
    });

    it("onPointerEvent forwards object pointer events and guards invalid payloads", () => {
      const listener = vi.fn();
      const unsubscribe = bridge().preview.onPointerEvent(listener);
      const wrapped = lastWrappedListener(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL);

      const pointerEvent = { x: 1, y: 2 };
      wrapped({}, pointerEvent);
      expect(listener).toHaveBeenCalledWith(pointerEvent);

      wrapped({}, null);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      expect(state.removeListener).toHaveBeenCalledWith(
        IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL,
        wrapped,
      );
    });
  });
});
