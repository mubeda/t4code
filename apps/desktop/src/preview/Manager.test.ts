import { it as effectIt } from "@effect/vitest";
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewRecordingFrame,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";

const {
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn(() => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeImage: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.die("unexpected getSession"),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const fileSystemLayer = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
});

const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(browserSessionLayer),
  Layer.provideMerge(environmentLayer),
  Layer.provideMerge(fileSystemLayer),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
);
const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(layer), Effect.scoped);

describe("PreviewManager", () => {
  beforeEach(() => {
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  effectIt.effect("reports an unregistered webview as temporarily unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });

        yield* manager.createTab("tab_1");

        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });
        expect(fromId).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("isolates failed state listeners and continues delivery", () => {
    const loggedErrors: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (typeof value === "object" && value !== null && "cause" in value) {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>));
        }
      }
    });
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: "send-window-message",
      platform: "darwin",
      windowId: 42,
      channel: "preview:state-change",
      cause: new Error("renderer unavailable"),
    });
    const delivered = vi.fn();

    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError));
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            delivered(tabId, state);
          }),
        );

        const state = yield* manager.createTab("tab_listener_failure");

        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledWith("tab_listener_failure", state);
        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError);
        expect(loggedErrors[0]).toMatchObject({
          operation: "send-window-message",
          windowId: 42,
          channel: "preview:state-change",
        });
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

  effectIt.effect("does not swallow state listener interruption", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.subscribeStateChanges(() => Effect.interrupt);
            return yield* Effect.exit(manager.createTab("tab_interrupted_listener"));
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    ),
  );

  effectIt.effect("queues navigation until the webview registers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "about:blank",
          getTitle: () => "",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

        expect(yield* manager.automationStatus("tab_pending")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_pending",
          url: "http://localhost:3200/",
          title: "",
          loading: true,
        });

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("mirrors Electron's effective zoom across registration and navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let effectiveZoom = 0.9;
        let zoomReadable = true;
        let url = "https://example.com";
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => {
            if (!zoomReadable) throw new Error("zoom unavailable");
            return effectiveZoom;
          },
          setZoomFactor,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_zoom");
        yield* manager.registerWebview("tab_zoom", 42);

        expect(states.at(-1)?.zoomFactor).toBe(0.9);
        expect(setZoomFactor).not.toHaveBeenCalled();

        effectiveZoom = 1.25;
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.zoomFactor).toBe(1.25);
        expect(setZoomFactor).not.toHaveBeenCalled();

        zoomReadable = false;
        url = "https://example.com/after-zoom-read-failed";
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url,
          title: "Example",
        });
        expect(states.at(-1)?.zoomFactor).toBe(1.25);

        const replacementSetZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 43,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: replacementSetZoomFactor,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.registerWebview("tab_zoom", 43);

        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.25);
        expect(states.at(-1)?.zoomFactor).toBe(1.25);
      }),
    ),
  );

  effectIt.effect("keeps a main-frame load failure visible until a retry starts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5733/";
        let loading = false;
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "localhost:5733",
          isLoading: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const statuses: PreviewManager.PreviewNavStatus[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            statuses.push(state.navStatus);
          }),
        );
        yield* manager.createTab("tab_failed");
        yield* manager.registerWebview("tab_failed", 42);

        listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://missing-frame.example/",
          false,
        );
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        listeners.get("did-stop-loading")?.();
        listeners.get("page-title-updated")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)).toEqual({
          kind: "LoadFailed",
          url,
          title: "localhost:5733",
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        });

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("LoadFailed");

        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect("captures a PNG screenshot into browser artifacts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com:8443/path?query=value",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({
            colorScheme: "light",
            primary: "oklch(0.488 0.217 264)",
          }),
        );

        const artifact = yield* manager.captureScreenshot("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts");
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect(artifact).toMatchObject({
          tabId: "tab_1",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
        });
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        );

        const captureCause = new Error("capture failed");
        capturePage.mockRejectedValueOnce(captureCause);
        const exit = yield* Effect.exit(manager.captureScreenshot("tab_1"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "captureScreenshot.capturePage",
          tabId: "tab_1",
          webContentsId: 42,
          cause: captureCause,
        });
      }),
    ),
  );

  effectIt.effect("keeps element picking active during subframe navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({}, "about:blank", false, false);
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({}, "https://example.com/next", false, true);
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("copies screenshot artifacts to the system clipboard", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

        yield* manager.copyArtifactToClipboard(artifactPath);

        expect(createFromPath).toHaveBeenCalledWith(artifactPath);
        expect(writeImage).toHaveBeenCalledOnce();
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);

        createFromPath.mockReturnValueOnce({ isEmpty: () => true });
        const invalidImageExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(invalidImageExit)).toBe(true);
        if (Exit.isSuccess(invalidImageExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(invalidImageExit.cause))).toMatchObject({
          _tag: "PreviewArtifactImageLoadError",
          artifactPath,
        });
      }),
    ),
  );

  effectIt.effect("emits the resolved pointer target before dispatching an automation click", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const activity: string[] = [];
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            activity.push("mousePressed");
            humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() => {
            activity.push(event.phase);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(activity).toEqual(["move", "click", "mousePressed"]);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
      }),
    ),
  );

  effectIt.effect("types in background webviews and enables native key input", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failKeyDown = false;
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (
            failKeyDown &&
            method === "Input.dispatchKeyEvent" &&
            (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
          ) {
            throw new Error("key dispatch failed");
          }
          if (
            method === "Input.dispatchKeyEvent" &&
            (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
          ) {
            humanInput?.(
              {},
              {
                kind: "key",
                key: params["key"],
                code: params["code"] ?? "Digit1",
              },
            );
          }
          return method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : undefined;
        });
        const restoreFocus = vi.fn();
        const focus = vi.fn();
        getFocusedWebContents.mockReturnValue({
          id: 7,
          isDestroyed: () => false,
          focus: restoreFocus,
        } as never);
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          focus,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationType("tab_input", { text: "hello", clear: true });
        yield* manager.automationType("tab_input", { text: "", clear: true });
        yield* manager.automationPress("tab_input", { key: "x" });

        const calls = sendCommand.mock.calls;
        const methods = calls.map(([method]) => method);
        const enableIndex = methods.indexOf("Input.setIgnoreInputEvents");
        const focusOnIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === true,
        );
        const keyDownIndex = calls.findIndex(
          ([method, params]) =>
            method === "Input.dispatchKeyEvent" && params?.["type"] === "keyDown",
        );
        const keyUpIndex = calls.findIndex(
          ([method, params]) => method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
        );
        const focusOffIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === false,
        );
        const typeEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('document.execCommand("insertText"'),
        );
        expect(typeEvaluation).toBeDefined();
        const clearOnlyEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('const text = ""') &&
            params.expression.includes("Object.getOwnPropertyDescriptor"),
        );
        expect(clearOnlyEvaluation).toBeDefined();
        expect(methods).not.toContain("Input.insertText");
        expect(enableIndex).toBeGreaterThanOrEqual(0);
        expect(focus).toHaveBeenCalledOnce();
        expect(restoreFocus).toHaveBeenCalledOnce();
        expect(methods).toContain("Page.bringToFront");
        expect(enableIndex).toBeLessThan(focusOnIndex);
        expect(focusOnIndex).toBeLessThan(keyDownIndex);
        expect(keyDownIndex).toBeLessThan(keyUpIndex);
        expect(keyUpIndex).toBeLessThan(focusOffIndex);
        expect(
          calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);
        expect(sendCommand).toHaveBeenCalledWith("Input.setIgnoreInputEvents", { ignore: false });

        sendCommand.mockClear();
        failKeyDown = true;
        const failedPress = yield* Effect.exit(manager.automationPress("tab_input", { key: "y" }));

        expect(Exit.isFailure(failedPress)).toBe(true);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "y",
          code: "KeyY",
          modifiers: 0,
          windowsVirtualKeyCode: 89,
          location: 0,
          isKeypad: false,
        });
        expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        expect(restoreFocus).toHaveBeenCalledTimes(2);
        expect(
          sendCommand.mock.calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);

        sendCommand.mockClear();
        failKeyDown = false;
        yield* manager.automationPress("tab_input", { key: "!" });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "!",
          code: "Digit1",
          modifiers: 0,
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
          text: "!",
          unmodifiedText: "!",
        });
        expect(restoreFocus).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          operation: "click",
          tabId: "tab_1",
          webContentsId: 42,
        });
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.name).toBe("PreviewAutomationControlInterruptedError");
        }
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("derives evaluation detail kind and length from the same non-empty source", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const text = "ReferenceError: fallbackDetail is not defined";
        const exceptionDetails = {
          text,
          exception: { description: "" },
        };
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { exceptionDetails } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const exit = yield* Effect.exit(
          manager.automationEvaluate("tab_1", { expression: "fallbackDetail" }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationEvaluationError",
          detailKind: "exception-text",
          detailLength: text.length,
          cause: exceptionDetails,
        });
      }),
    ),
  );
});

describe("PreviewOperationError", () => {
  it("keeps timeline detail separate from its structured message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new PreviewManager.PreviewOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "tab_1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});

describe("Preview automation diagnostics", () => {
  it("keeps browser exception detail out of structural diagnostics", () => {
    const secret = "unrelated-browser-payload-secret";
    const detail = "ReferenceError: missingValue is not defined";
    const cause = {
      text: "Uncaught Error",
      exception: { description: detail },
      unsafePayload: secret,
    };
    const error = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: "tab_1",
      detailKind: "exception-description",
      detailLength: detail.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error.message).toBe("Preview JavaScript evaluation failed in tab tab_1");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(encodedDiagnostics)).not.toContain(secret);
    expect("detail" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).toBe(detail);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).not.toContain(
      secret,
    );
  });

  it("retains bounded selector diagnostics without exposing selector or reason text", () => {
    const selector = "role=button[name='selector-secret']";
    const reason = "Unexpected token near reason-secret";
    const cause = { invalidSelector: true as const, message: reason };
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_1",
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error).toMatchObject({
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
    });
    expect(error.detail).toEqual({
      selectorKind: "locator",
      selectorLength: selector.length,
    });
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(encodedDiagnostics)).not.toContain("secret");
    expect("selector" in error).toBe(false);
    expect("reason" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(error)).toBe(
      reason,
    );
  });

  it("does not retain a missing target locator", () => {
    const selector = "[data-token='target-secret']";
    const error = new PreviewManager.PreviewAutomationTargetNotFoundError({
      operation: "scroll",
      tabId: "tab_1",
      selectorKind: "selector",
      selectorLength: selector.length,
    });

    expect(error.message).not.toContain(selector);
    expect(JSON.stringify(error)).not.toContain(selector);
    expect("locator" in error).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extended coverage: webview lifecycle, automation flows, diagnostics,
// artifacts, and error surfaces.
// ---------------------------------------------------------------------------

const testAnnotationTheme: DesktopPreviewAnnotationTheme = {
  colorScheme: "dark",
  radius: "0.5rem",
  background: "black",
  foreground: "white",
  popover: "black",
  popoverForeground: "white",
  primary: "#3366ff",
  primaryForeground: "black",
  muted: "gray",
  mutedForeground: "silver",
  accent: "gray",
  accentForeground: "white",
  border: "gray",
  input: "gray",
  ring: "#3366ff",
  fontSans: "sans-serif",
  fontMono: "monospace",
};

interface FakeImage {
  getSize: () => { width: number; height: number };
  toPNG: () => Buffer;
  toDataURL: () => string;
  resize: (options: { width: number }) => FakeImage;
}

const makeImage = (width: number, height: number): FakeImage => ({
  getSize: () => ({ width, height }),
  toPNG: () => Buffer.from(`png-${width}x${height}`),
  toDataURL: () => `data:image/png;base64,${width}x${height}`,
  resize: ({ width: nextWidth }) => makeImage(nextWidth, Math.round((height * nextWidth) / width)),
});

interface FakeWebContentsOptions {
  readonly id?: number;
  readonly type?: string;
  readonly url?: string;
  readonly title?: string;
  readonly loading?: boolean;
  readonly devToolsOpened?: boolean;
  readonly debuggerAttached?: boolean;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly capturePage?: (rect?: unknown) => Promise<FakeImage>;
  readonly sendCommand?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

const makeWebContents = (options: FakeWebContentsOptions = {}) => {
  const listeners = new Map<string, Array<unknown>>();
  const ipcListeners = new Map<string, Array<(...args: Array<unknown>) => void>>();
  const debuggerListeners: Array<
    (event: unknown, method: string, params: Record<string, unknown>) => void
  > = [];
  const state = {
    url: options.url ?? "https://example.com/",
    title: options.title ?? "Example",
    loading: options.loading ?? false,
    destroyed: false,
    devToolsOpened: options.devToolsOpened ?? false,
    canGoBack: options.canGoBack ?? false,
    canGoForward: options.canGoForward ?? false,
    zoom: 1,
    windowOpenHandler: null as null | ((details: { url: string }) => { action: string }),
    hostWebContents: undefined as unknown,
  };
  let attached = options.debuggerAttached ?? false;
  const addListener = (event: string, listener: unknown): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const removeListener = (event: string, listener: unknown): void => {
    listeners.set(
      event,
      (listeners.get(event) ?? []).filter((existing) => existing !== listener),
    );
  };
  const removeIpcListener = (channel: string, listener: unknown): void => {
    ipcListeners.set(
      channel,
      (ipcListeners.get(channel) ?? []).filter((existing) => existing !== listener),
    );
  };
  const sendCommand = vi.fn(options.sendCommand ?? (async (): Promise<unknown> => undefined));
  const mocks = {
    focus: vi.fn(),
    send: vi.fn(),
    loadURL: vi.fn(async (url: string) => {
      state.url = url;
    }),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    setZoomFactor: vi.fn((factor: number) => {
      state.zoom = factor;
    }),
    goBack: vi.fn(),
    goForward: vi.fn(),
    openDevTools: vi.fn(),
    devToolsFocus: vi.fn(),
    capturePage: vi.fn(options.capturePage ?? (async (_rect?: unknown) => makeImage(64, 48))),
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    off: vi.fn(removeListener),
  };
  const wc = {
    id: options.id ?? 42,
    isDestroyed: () => state.destroyed,
    getType: () => options.type ?? "webview",
    getURL: () => state.url,
    getTitle: () => state.title,
    isLoading: () => state.loading,
    isFocused: () => false,
    focus: mocks.focus,
    getZoomFactor: () => state.zoom,
    setZoomFactor: mocks.setZoomFactor,
    loadURL: mocks.loadURL,
    reload: mocks.reload,
    reloadIgnoringCache: mocks.reloadIgnoringCache,
    capturePage: mocks.capturePage,
    send: mocks.send,
    on: vi.fn(addListener),
    once: vi.fn(addListener),
    off: mocks.off,
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
      state.windowOpenHandler = handler;
    }),
    navigationHistory: {
      canGoBack: () => state.canGoBack,
      canGoForward: () => state.canGoForward,
      goBack: mocks.goBack,
      goForward: mocks.goForward,
    },
    isDevToolsOpened: () => state.devToolsOpened,
    openDevTools: mocks.openDevTools,
    devToolsWebContents: { focus: mocks.devToolsFocus },
    ipc: {
      on: vi.fn((channel: string, listener: (...args: Array<unknown>) => void) => {
        ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener]);
      }),
      off: vi.fn(removeIpcListener),
      removeListener: vi.fn(removeIpcListener),
    },
    debugger: {
      isAttached: () => attached,
      attach: mocks.attach,
      detach: mocks.detach,
      on: vi.fn(
        (
          _event: string,
          listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
        ) => {
          debuggerListeners.push(listener);
        },
      ),
      off: vi.fn(),
      sendCommand,
    },
    get hostWebContents() {
      return state.hostWebContents;
    },
  };
  return {
    wc: wc as never,
    state,
    mocks,
    sendCommand,
    emit: (event: string, ...args: Array<unknown>): void => {
      for (const listener of Array.from(listeners.get(event) ?? [])) {
        (listener as (...values: Array<unknown>) => void)(...args);
      }
    },
    emitIpc: (channel: string, ...args: Array<unknown>): void => {
      for (const listener of Array.from(ipcListeners.get(channel) ?? [])) listener(...args);
    },
    emitDebuggerMessage: (method: string, params: Record<string, unknown>): void => {
      for (const listener of Array.from(debuggerListeners)) listener({}, method, params);
    },
  };
};

const flushRuntime = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(() => setImmediate(() => setImmediate(resolve)));
    }),
);

const failedError = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure exit");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

describe("PreviewManager webview operations", () => {
  beforeEach(() => {
    fromId.mockReset();
    fromId.mockImplementation(() => null);
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  effectIt.effect("drives history and reload controls through the registered webview", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents({ canGoBack: true });
        fromId.mockReturnValue(harness.wc);

        expect(failedError(yield* Effect.exit(manager.goBack("tab_nav")))).toMatchObject({
          _tag: "PreviewTabNotFoundError",
          tabId: "tab_nav",
        });
        yield* manager.createTab("tab_nav");
        expect(failedError(yield* Effect.exit(manager.goBack("tab_nav")))).toMatchObject({
          _tag: "PreviewWebviewNotInitializedError",
          tabId: "tab_nav",
        });

        yield* manager.registerWebview("tab_nav", 42);
        yield* manager.goBack("tab_nav");
        expect(harness.mocks.goBack).toHaveBeenCalledOnce();
        yield* manager.goForward("tab_nav");
        expect(harness.mocks.goForward).not.toHaveBeenCalled();
        harness.state.canGoForward = true;
        yield* manager.goForward("tab_nav");
        expect(harness.mocks.goForward).toHaveBeenCalledOnce();
        yield* manager.refresh("tab_nav");
        expect(harness.mocks.reload).toHaveBeenCalledOnce();
        yield* manager.hardReload("tab_nav");
        expect(harness.mocks.reloadIgnoringCache).toHaveBeenCalledOnce();

        yield* manager.clearCookies();
        yield* manager.clearCache();
        expect(yield* manager.getBrowserPartition()).toBe("persist:t3code-preview-test");
        expect(manager.isBrowserPartition("persist:t3code-preview-abc")).toBe(true);
        expect(manager.isBrowserPartition("persist:other")).toBe(false);

        fromId.mockReturnValue(null);
        expect(failedError(yield* Effect.exit(manager.goBack("tab_nav")))).toMatchObject({
          _tag: "PreviewWebContentsNotFoundError",
          tabId: "tab_nav",
          webContentsId: 42,
        });
      }),
    ),
  );

  effectIt.effect("reloads same-url navigation and detaches vanished webContents", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents({ url: "http://localhost:3200/" });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_nav2");
        yield* manager.registerWebview("tab_nav2", 42);

        yield* manager.navigate("tab_nav2", "localhost:3200");
        expect(harness.mocks.reload).toHaveBeenCalledOnce();
        expect(harness.mocks.loadURL).not.toHaveBeenCalled();

        yield* manager.navigate("tab_nav2", "localhost:9999");
        expect(harness.mocks.loadURL).toHaveBeenCalledWith("http://localhost:9999/");

        expect(failedError(yield* Effect.exit(manager.navigate("tab_nav2", "   ")))).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "navigate.normalizeUrl",
          tabId: "tab_nav2",
        });

        fromId.mockReturnValue(null);
        yield* manager.navigate("tab_nav2", "localhost:3200");
        expect(yield* manager.automationStatus("tab_nav2")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_nav2",
          url: "http://localhost:3200/",
          title: "Example",
          loading: true,
        });
      }),
    ),
  );

  effectIt.effect("steps through Chrome's zoom presets and resets them", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const states: Array<PreviewManager.PreviewTabState> = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_zoom");
        yield* manager.zoomIn("tab_zoom");
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
        yield* manager.zoomIn("tab_zoom");
        expect(states.at(-1)?.zoomFactor).toBe(1.25);
        yield* manager.zoomOut("tab_zoom");
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
        yield* manager.resetZoom("tab_zoom");
        expect(states.at(-1)?.zoomFactor).toBe(1);
        const emitted = states.length;
        yield* manager.resetZoom("tab_zoom");
        expect(states).toHaveLength(emitted);

        yield* manager.zoomIn("tab_missing");
        expect(states).toHaveLength(emitted);

        const harness = makeWebContents();
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_zoom_wc");
        yield* manager.registerWebview("tab_zoom_wc", 42);
        yield* manager.zoomIn("tab_zoom_wc");
        expect(harness.mocks.setZoomFactor).toHaveBeenCalledWith(1.1);
      }),
    ),
  );

  effectIt.effect("opens detached devtools and restores the control session afterwards", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents();
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_dev");
        yield* manager.registerWebview("tab_dev", 42);
        yield* flushRuntime;
        expect(harness.mocks.attach).toHaveBeenCalledTimes(1);

        yield* manager.openDevTools("tab_dev");
        expect(harness.mocks.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
        expect(harness.mocks.detach).toHaveBeenCalledTimes(1);

        harness.emit("devtools-closed");
        yield* flushRuntime;
        expect(harness.mocks.attach).toHaveBeenCalledTimes(2);

        const openedHarness = makeWebContents({ id: 43, devToolsOpened: true });
        fromId.mockReturnValue(openedHarness.wc);
        yield* manager.createTab("tab_dev_open");
        yield* manager.registerWebview("tab_dev_open", 43);
        yield* manager.openDevTools("tab_dev_open");
        expect(openedHarness.mocks.devToolsFocus).toHaveBeenCalledOnce();
        expect(openedHarness.mocks.openDevTools).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("validates webview registration ownership and type", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(
          failedError(yield* Effect.exit(manager.registerWebview("missing", 42))),
        ).toMatchObject({ _tag: "PreviewTabNotFoundError", tabId: "missing" });

        const windowContents = makeWebContents({ id: 42, type: "window" });
        const webviewContents = makeWebContents({ id: 43 });
        fromId.mockImplementation(((id: number) =>
          id === 42 ? windowContents.wc : id === 43 ? webviewContents.wc : null) as never);

        yield* manager.createTab("tab_reg");
        expect(
          failedError(yield* Effect.exit(manager.registerWebview("tab_reg", 42))),
        ).toMatchObject({
          _tag: "PreviewWebContentsNotFoundError",
          tabId: "tab_reg",
          webContentsId: 42,
        });

        const mainWindow = { isDestroyed: () => false, webContents: { sendInputEvent: vi.fn() } };
        yield* manager.setMainWindow(mainWindow as never);
        expect(
          failedError(yield* Effect.exit(manager.registerWebview("tab_reg", 43))),
        ).toMatchObject({
          _tag: "PreviewWebContentsNotFoundError",
          tabId: "tab_reg",
          webContentsId: 43,
        });

        webviewContents.state.hostWebContents = mainWindow.webContents;
        yield* manager.registerWebview("tab_reg", 43);
        expect(webviewContents.mocks.send).toHaveBeenCalledTimes(1);
        yield* manager.registerWebview("tab_reg", 43);
        expect(webviewContents.mocks.send).toHaveBeenCalledTimes(2);
        expect(webviewContents.mocks.send).toHaveBeenLastCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({ colorScheme: "light" }),
        );
      }),
    ),
  );

  effectIt.effect("broadcasts annotation themes to live webviews only", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const liveHarness = makeWebContents({ id: 42 });
        const destroyedHarness = makeWebContents({ id: 44 });
        fromId.mockImplementation(((id: number) =>
          id === 42 ? liveHarness.wc : id === 44 ? destroyedHarness.wc : null) as never);

        yield* manager.createTab("tab_live");
        yield* manager.registerWebview("tab_live", 42);
        yield* manager.createTab("tab_detached");
        yield* manager.createTab("tab_destroyed");
        yield* manager.registerWebview("tab_destroyed", 44);
        destroyedHarness.state.destroyed = true;
        liveHarness.mocks.send.mockClear();
        destroyedHarness.mocks.send.mockClear();

        yield* manager.setAnnotationTheme(testAnnotationTheme);
        expect(liveHarness.mocks.send).toHaveBeenCalledWith(
          "preview:annotation-theme",
          testAnnotationTheme,
        );
        expect(destroyedHarness.mocks.send).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("records one tab at a time and streams screencast frames", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents();
        fromId.mockReturnValue(harness.wc);
        const frames: Array<DesktopPreviewRecordingFrame> = [];
        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_rec");
        yield* manager.registerWebview("tab_rec", 42);
        yield* flushRuntime;

        yield* manager.startRecording("tab_rec");
        expect(harness.sendCommand).toHaveBeenCalledWith("Page.enable", undefined);
        expect(harness.sendCommand).toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.objectContaining({ format: "jpeg" }),
        );

        expect(failedError(yield* Effect.exit(manager.startRecording("tab_other")))).toMatchObject({
          _tag: "PreviewRecordingAlreadyActiveError",
          requestedTabId: "tab_other",
          activeTabId: "tab_rec",
        });
        yield* manager.startRecording("tab_rec");

        harness.emitDebuggerMessage("Page.screencastFrame", {
          sessionId: 7,
          data: "frame-data",
          metadata: { deviceWidth: 320, deviceHeight: 200 },
        });
        yield* flushRuntime;
        expect(frames.at(-1)).toMatchObject({
          tabId: "tab_rec",
          data: "frame-data",
          width: 320,
          height: 200,
        });
        expect(harness.sendCommand).toHaveBeenCalledWith("Page.screencastFrameAck", {
          sessionId: 7,
        });

        harness.emitDebuggerMessage("Page.screencastFrame", { sessionId: "not-a-number" });
        yield* flushRuntime;
        expect(frames).toHaveLength(1);

        yield* manager.stopRecording("tab_other");
        yield* manager.stopRecording("tab_rec");
        expect(harness.sendCommand).toHaveBeenCalledWith("Page.stopScreencast", undefined);
      }),
    ),
  );

  effectIt.effect("collects console and network diagnostics into snapshots", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const pageInfo = {
          url: "https://example.com/",
          title: "Example",
          loading: false,
          visibleText: "Welcome",
          interactiveElements: [],
        };
        const harness = makeWebContents({
          capturePage: async () => makeImage(2000, 1000),
          sendCommand: async (method, params) => {
            if (method === "Runtime.evaluate") {
              const expression = String(params?.["expression"] ?? "");
              if (expression.includes("interactiveElements")) {
                return { result: { value: pageInfo } };
              }
              return { result: { value: true } };
            }
            if (method === "Accessibility.getFullAXTree") {
              return { nodes: [{ role: "main" }] };
            }
            return undefined;
          },
        });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_diag");
        yield* manager.registerWebview("tab_diag", 42);
        yield* flushRuntime;

        const post = (method: string, params: Record<string, unknown>) =>
          Effect.gen(function* () {
            harness.emitDebuggerMessage(method, params);
            yield* flushRuntime;
          });
        yield* post("Runtime.consoleAPICalled", {
          type: "warn",
          args: [{ value: "hello" }, { description: "desc" }, "plain"],
        });
        yield* post("Runtime.exceptionThrown", { exceptionDetails: { text: "Boom" } });
        yield* post("Runtime.exceptionThrown", {});
        yield* post("Log.entryAdded", {
          entry: { level: "warning", text: "log-line", source: "network" },
        });
        yield* post("Log.entryAdded", {});
        yield* post("Network.requestWillBeSent", {
          requestId: "r1",
          request: { url: "https://api.test/x", method: "POST" },
        });
        yield* post("Network.responseReceived", { requestId: "r1", response: { status: 500 } });
        yield* post("Network.requestWillBeSent", {
          requestId: "r2",
          request: { url: "https://api.test/y", method: "GET" },
        });
        yield* post("Network.responseReceived", { requestId: "r2", response: { status: 200 } });
        yield* post("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_FAILED" });
        yield* post("Network.requestWillBeSent", {
          requestId: "r3",
          request: { url: "https://api.test/z", method: "GET" },
        });
        yield* post("Network.loadingFinished", { requestId: "r3" });
        yield* post("Network.loadingFailed", { requestId: "unknown" });
        yield* post("Unrelated.method", {});

        const snapshot = yield* manager.automationSnapshot("tab_diag");
        expect(snapshot).toMatchObject({
          url: "https://example.com/",
          title: "Example",
          loading: false,
          visibleText: "Welcome",
          interactiveElements: [],
          accessibilityTree: { nodes: [{ role: "main" }] },
        });
        expect(snapshot.consoleEntries).toMatchObject([
          { level: "warn", text: "hello desc plain", source: "console" },
          { level: "error", text: "Boom", source: "exception" },
          { level: "error", text: "Uncaught exception", source: "exception" },
          { level: "warning", text: "log-line", source: "network" },
          { level: "info", text: "", source: "log" },
        ]);
        expect(snapshot.networkEntries).toMatchObject([
          { url: "https://api.test/x", method: "POST", status: 500, failed: true },
          {
            url: "https://api.test/y",
            method: "GET",
            status: null,
            failed: true,
            errorText: "net::ERR_FAILED",
          },
        ]);
        expect(snapshot.screenshot).toMatchObject({
          mimeType: "image/png",
          width: 1280,
          height: 640,
        });
        expect(snapshot.actionTimeline.length).toBeGreaterThanOrEqual(1);
        expect(snapshot.actionTimeline.at(-1)).toMatchObject({
          action: "snapshot",
          status: "running",
        });
      }),
    ),
  );

  effectIt.effect("waits for page conditions and times out on the test clock", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let matched = false;
        let invalid = false;
        const harness = makeWebContents({
          sendCommand: async (method, params) => {
            if (method !== "Runtime.evaluate") return undefined;
            const expression = String(params?.["expression"] ?? "");
            if (expression.includes("Boolean(globalThis.__t3PlaywrightInjected)")) {
              return { result: { value: true } };
            }
            if (expression.includes("selectorMatched")) {
              return invalid
                ? { result: { value: { invalidSelector: true, message: "bad locator" } } }
                : { result: { value: { matched } } };
            }
            return { result: { value: true } };
          },
        });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_wait");
        yield* manager.registerWebview("tab_wait", 42);

        matched = true;
        yield* manager.automationWaitFor("tab_wait", {
          selector: "#app",
          text: "Ready",
          urlIncludes: "/done",
        });

        matched = false;
        const timedOut = yield* manager
          .automationWaitFor("tab_wait", { timeoutMs: 250 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        for (let index = 0; index < 4; index += 1) {
          yield* TestClock.adjust(100);
          yield* flushRuntime;
        }
        expect(failedError(yield* Fiber.await(timedOut))).toMatchObject({
          _tag: "PreviewAutomationTimeoutError",
          tabId: "tab_wait",
          timeoutMs: 250,
        });

        invalid = true;
        expect(
          failedError(
            yield* Effect.exit(manager.automationWaitFor("tab_wait", { selector: "#gone" })),
          ),
        ).toMatchObject({
          _tag: "PreviewAutomationInvalidSelectorError",
          operation: "waitFor",
          selectorKind: "selector",
        });
      }),
    ),
  );

  effectIt.effect("clicks through locators and validates viewport bounds", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let point: Record<string, unknown> = { x: 10, y: 20 };
        const harness = makeWebContents({
          sendCommand: async (method, params) => {
            if (method !== "Runtime.evaluate") return undefined;
            const expression = String(params?.["expression"] ?? "");
            if (expression.includes("Boolean(globalThis.__t3PlaywrightInjected)")) {
              return { result: { value: true } };
            }
            if (expression.includes("window.innerWidth")) {
              return { result: { value: { width: 800, height: 600 } } };
            }
            if (expression.includes("parseSelector")) {
              return { result: { value: point } };
            }
            return { result: { value: true } };
          },
        });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_click");
        yield* manager.registerWebview("tab_click", 42);

        const click = yield* manager
          .automationClick("tab_click", { locator: "role=button" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        yield* Fiber.join(click);
        expect(harness.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 10,
          y: 20,
          button: "left",
          clickCount: 1,
        });

        point = { notFound: true };
        expect(
          failedError(
            yield* Effect.exit(manager.automationClick("tab_click", { selector: "#gone" })),
          ),
        ).toMatchObject({
          _tag: "PreviewAutomationTargetNotFoundError",
          operation: "click",
          selectorKind: "selector",
        });

        point = { invalidSelector: true, message: "nope" };
        expect(
          failedError(
            yield* Effect.exit(manager.automationClick("tab_click", { locator: "css=]" })),
          ),
        ).toMatchObject({
          _tag: "PreviewAutomationInvalidSelectorError",
          operation: "click",
          selectorKind: "locator",
          reasonLength: 4,
        });

        expect(
          failedError(yield* Effect.exit(manager.automationClick("tab_click", { x: 900, y: 20 }))),
        ).toMatchObject({
          _tag: "PreviewAutomationCoordinatesOutsideViewportError",
          x: 900,
          y: 20,
          viewportWidth: 800,
          viewportHeight: 600,
        });
      }),
    ),
  );

  effectIt.effect("guards automation when devtools or another debugger own the webview", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const devtoolsHarness = makeWebContents({ id: 42, devToolsOpened: true });
        const debuggedHarness = makeWebContents({ id: 43, debuggerAttached: true });
        fromId.mockImplementation(((id: number) =>
          id === 42 ? devtoolsHarness.wc : id === 43 ? debuggedHarness.wc : null) as never);

        yield* manager.createTab("tab_devtools");
        yield* manager.registerWebview("tab_devtools", 42);
        expect(
          failedError(
            yield* Effect.exit(manager.automationEvaluate("tab_devtools", { expression: "1" })),
          ),
        ).toMatchObject({ _tag: "PreviewAutomationDevToolsOpenError", webContentsId: 42 });

        yield* manager.createTab("tab_debugged");
        yield* manager.registerWebview("tab_debugged", 43);
        expect(
          failedError(
            yield* Effect.exit(manager.automationEvaluate("tab_debugged", { expression: "1" })),
          ),
        ).toMatchObject({ _tag: "PreviewAutomationDebuggerAttachedError", webContentsId: 43 });
      }),
    ),
  );

  effectIt.effect("evaluates expressions and enforces the result size limit", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let value: unknown = 42;
        const harness = makeWebContents({
          sendCommand: async (method) =>
            method === "Runtime.evaluate" ? { result: { value } } : undefined,
        });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_eval");
        yield* manager.registerWebview("tab_eval", 42);

        expect(yield* manager.automationEvaluate("tab_eval", { expression: "6 * 7" })).toBe(42);

        value = "x".repeat(70_000);
        const error = failedError(
          yield* Effect.exit(manager.automationEvaluate("tab_eval", { expression: "big" })),
        );
        expect(error).toMatchObject({
          _tag: "PreviewAutomationResultTooLargeError",
          tabId: "tab_eval",
          maximumBytes: 64_000,
        });
        expect(
          (error as PreviewManager.PreviewAutomationResultTooLargeError).actualBytes,
        ).toBeGreaterThan(64_000);
      }),
    ),
  );

  effectIt.effect("reports typing failures with structural diagnostics", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let result: Record<string, unknown> = { notFound: true };
        const harness = makeWebContents({
          sendCommand: async (method, params) => {
            if (method !== "Runtime.evaluate") return undefined;
            const expression = String(params?.["expression"] ?? "");
            if (expression.includes("Boolean(globalThis.__t3PlaywrightInjected)")) {
              return { result: { value: true } };
            }
            if (expression.includes("execCommand")) {
              return { result: { value: result } };
            }
            return { result: { value: true } };
          },
        });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_type");
        yield* manager.registerWebview("tab_type", 42);

        expect(
          failedError(
            yield* Effect.exit(manager.automationType("tab_type", { selector: "#a", text: "x" })),
          ),
        ).toMatchObject({
          _tag: "PreviewAutomationTargetNotFoundError",
          operation: "type",
          selectorKind: "selector",
        });

        result = { notEditable: true };
        expect(
          failedError(yield* Effect.exit(manager.automationType("tab_type", { text: "x" }))),
        ).toMatchObject({
          _tag: "PreviewAutomationTargetNotEditableError",
          selectorKind: "focused-element",
        });

        result = { invalidSelector: true, message: "sel!" };
        expect(
          failedError(
            yield* Effect.exit(manager.automationType("tab_type", { locator: "bad", text: "x" })),
          ),
        ).toMatchObject({
          _tag: "PreviewAutomationInvalidSelectorError",
          operation: "type",
          selectorKind: "locator",
        });
      }),
    ),
  );

  effectIt.effect("scrolls the window or a locator target", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let result: Record<string, unknown> = { ok: true };
        const harness = makeWebContents({
          sendCommand: async (method, params) => {
            if (method !== "Runtime.evaluate") return undefined;
            const expression = String(params?.["expression"] ?? "");
            if (expression.includes("Boolean(globalThis.__t3PlaywrightInjected)")) {
              return { result: { value: true } };
            }
            if (expression.includes("scrollBy")) {
              return { result: { value: result } };
            }
            return { result: { value: true } };
          },
        });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_scroll");
        yield* manager.registerWebview("tab_scroll", 42);

        yield* manager.automationScroll("tab_scroll", { deltaY: 120 });

        result = { notFound: true };
        expect(
          failedError(
            yield* Effect.exit(manager.automationScroll("tab_scroll", { selector: "#gone" })),
          ),
        ).toMatchObject({
          _tag: "PreviewAutomationTargetNotFoundError",
          operation: "scroll",
          selectorKind: "selector",
        });

        result = { invalidSelector: true, message: "broken" };
        expect(
          failedError(
            yield* Effect.exit(manager.automationScroll("tab_scroll", { locator: "css=]" })),
          ),
        ).toMatchObject({
          _tag: "PreviewAutomationInvalidSelectorError",
          operation: "scroll",
          selectorKind: "locator",
        });
      }),
    ),
  );

  effectIt.effect("closes tabs, detaching listeners and control sessions", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents();
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_close");
        yield* manager.registerWebview("tab_close", 42);
        yield* flushRuntime;

        harness.state.destroyed = true;
        expect(yield* manager.automationStatus("tab_close")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_close",
          url: null,
          title: null,
          loading: false,
        });
        harness.state.destroyed = false;

        const states: Array<PreviewManager.PreviewTabState> = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.closeTab("tab_close");
        expect(harness.mocks.off).toHaveBeenCalledWith("did-navigate", expect.any(Function));
        expect(harness.mocks.detach).toHaveBeenCalledOnce();
        expect(states.at(-1)).toMatchObject({
          tabId: "tab_close",
          webContentsId: null,
          navStatus: { kind: "Idle" },
        });

        yield* manager.closeTab("tab_close");
        expect(states).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("marks the controller human on unexpected input and releases it", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents();
        fromId.mockReturnValue(harness.wc);
        const states: Array<PreviewManager.PreviewTabState> = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_human");
        yield* manager.registerWebview("tab_human", 42);

        harness.emitIpc("preview:human-input", {}, undefined);
        yield* flushRuntime;
        expect(states.at(-1)?.controller).toBe("human");

        yield* TestClock.adjust(750);
        yield* flushRuntime;
        expect(states.at(-1)?.controller).toBe("none");
      }),
    ),
  );

  effectIt.effect("denies popup windows and forwards app shortcuts to the main window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents();
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_popup");
        yield* manager.registerWebview("tab_popup", 42);

        const decision = harness.state.windowOpenHandler?.({ url: "https://popup.test/" });
        expect(decision).toEqual({ action: "deny" });
        yield* flushRuntime;
        expect(harness.mocks.loadURL).toHaveBeenCalledWith("https://popup.test/");

        const sendInputEvent = vi.fn();
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          webContents: { sendInputEvent },
        } as never);

        const forwarded = { preventDefault: vi.fn() };
        harness.emit("before-input-event", forwarded, {
          type: "keyDown",
          key: "J",
          meta: true,
          shift: true,
          control: false,
          alt: false,
        });
        yield* flushRuntime;
        expect(forwarded.preventDefault).toHaveBeenCalledOnce();
        expect(sendInputEvent).toHaveBeenCalledWith({
          type: "keyDown",
          keyCode: "J",
          modifiers: ["meta", "shift"],
        });

        const ignored = { preventDefault: vi.fn() };
        harness.emit("before-input-event", ignored, {
          type: "keyDown",
          key: "q",
          meta: true,
          shift: false,
          control: false,
          alt: false,
        });
        yield* flushRuntime;
        expect(ignored.preventDefault).not.toHaveBeenCalled();
        expect(sendInputEvent).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  effectIt.effect("resolves element picks with cropped annotation screenshots", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const harness = makeWebContents();
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_pick");
        yield* manager.registerWebview("tab_pick", 42);
        const annotationPayload = {
          id: "annotation_1",
          pageUrl: "https://example.com/",
          pageTitle: "Example",
          comment: "Fix this",
          createdAt: "2026-01-01T00:00:00.000Z",
          screenshot: null,
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
        };

        const pick = yield* manager.pickElement("tab_pick").pipe(Effect.forkChild);
        yield* flushRuntime;
        expect(harness.mocks.send).toHaveBeenCalledWith(
          "preview:start-pick",
          expect.objectContaining({ colorScheme: "light" }),
        );
        harness.emitIpc("preview:element-picked", {}, annotationPayload, {
          x: 1.2,
          y: 2.8,
          width: 10.1,
          height: 20.4,
        });
        yield* flushRuntime;
        const picked = yield* Fiber.join(pick);
        expect(picked).toMatchObject({
          id: "annotation_1",
          screenshot: {
            width: 64,
            height: 48,
            cropRect: { x: 1, y: 2, width: 11, height: 21 },
          },
        });
        expect(harness.mocks.capturePage).toHaveBeenCalledWith({
          x: 1,
          y: 2,
          width: 11,
          height: 21,
        });
        expect(harness.mocks.send).toHaveBeenCalledWith("preview:annotation-captured");

        const invalidPick = yield* manager.pickElement("tab_pick").pipe(Effect.forkChild);
        yield* flushRuntime;
        harness.emitIpc("preview:element-picked", {}, { not: "an annotation" });
        yield* flushRuntime;
        expect(yield* Fiber.join(invalidPick)).toBeNull();

        harness.mocks.capturePage.mockRejectedValueOnce(new Error("capture failed"));
        const uncroppedPick = yield* manager.pickElement("tab_pick").pipe(Effect.forkChild);
        yield* flushRuntime;
        harness.emitIpc("preview:element-picked", {}, annotationPayload, {
          x: 0,
          y: 0,
          width: -5,
          height: 2,
        });
        yield* flushRuntime;
        const uncropped = yield* Fiber.join(uncroppedPick);
        expect(uncropped).toMatchObject({ id: "annotation_1", screenshot: null });
        expect(harness.mocks.capturePage).toHaveBeenLastCalledWith(undefined);

        const cancelledPick = yield* manager.pickElement("tab_pick").pipe(Effect.forkChild);
        yield* flushRuntime;
        yield* manager.cancelPickElement("tab_pick");
        yield* flushRuntime;
        expect(yield* Fiber.join(cancelledPick)).toBeNull();
        expect(harness.mocks.send).toHaveBeenCalledWith("preview:cancel-pick");

        const destroyedPick = yield* manager.pickElement("tab_pick").pipe(Effect.forkChild);
        yield* flushRuntime;
        harness.emit("destroyed");
        yield* flushRuntime;
        expect(yield* Fiber.join(destroyedPick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("saves recordings and slugs hostile capture URLs", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const data = new Uint8Array([1, 2, 3]);
        const mp4 = yield* manager.saveRecording("tab_rec", "video/mp4", data);
        expect(mp4.path).toMatch(/browser-recording-[a-z0-9]+\.mp4$/);
        expect(mp4).toMatchObject({ tabId: "tab_rec", mimeType: "video/mp4", sizeBytes: 3 });
        expect(writeFile).toHaveBeenCalledWith(mp4.path, data);

        const webm = yield* manager.saveRecording("tab_rec", "video/webm", data);
        expect(webm.path).toMatch(/browser-recording-[a-z0-9]+\.webm$/);

        const harness = makeWebContents({ url: "not a valid url" });
        fromId.mockReturnValue(harness.wc);
        yield* manager.createTab("tab_shot");
        yield* manager.registerWebview("tab_shot", 42);
        const artifact = yield* manager.captureScreenshot("tab_shot");
        expect(artifact.id).toMatch(/^browser-screenshot-site-/);
      }),
    ),
  );

  effectIt.effect("maps browser session failures into preview operation errors", () => {
    const creationError = new BrowserSession.BrowserSessionCreationError({
      scope: "thread-1",
      partition: "persist:t3code-preview-x",
      cause: new Error("session create failed"),
    });
    const derivationError = new BrowserSession.BrowserSessionPartitionDerivationError({
      scope: "thread-1",
      cause: PlatformError.systemError({
        _tag: "Unknown",
        module: "Crypto",
        method: "digest",
        cause: new Error("digest failed"),
      }),
    });
    const storageError = new BrowserSession.BrowserSessionStorageClearError({
      partition: "persist:t3code-preview-x",
      cause: new Error("storage clear failed"),
    });
    const cacheError = new BrowserSession.BrowserSessionCacheClearError({
      partition: "persist:t3code-preview-x",
      cause: new Error("cache clear failed"),
    });
    const fakeSession = { partition: "persist:t3code-preview-x" };
    const failingLayer = PreviewManager.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(
          BrowserSession.BrowserSession,
          BrowserSession.BrowserSession.of({
            getPartition: (scope) =>
              scope === "fail"
                ? Effect.fail(derivationError)
                : Effect.succeed("persist:t3code-preview-x"),
            isPartition: (partition) => partition === "persist:t3code-preview-x",
            getSession: (scope) =>
              scope === "fail" ? Effect.fail(creationError) : Effect.succeed(fakeSession as never),
            clearCookies: () => Effect.fail(storageError),
            clearCache: () => Effect.fail(cacheError),
          }),
        ),
      ),
      Layer.provideMerge(environmentLayer),
      Layer.provideMerge(fileSystemLayer),
      Layer.provideMerge(Path.layer),
      Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
    );

    return Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      expect(yield* manager.getBrowserSession()).toBe(fakeSession);
      expect(failedError(yield* Effect.exit(manager.getBrowserSession("fail")))).toMatchObject({
        _tag: "PreviewOperationError",
        operation: "getBrowserSession",
        cause: creationError,
      });
      expect(yield* manager.getBrowserPartition()).toBe("persist:t3code-preview-x");
      expect(failedError(yield* Effect.exit(manager.getBrowserPartition("fail")))).toMatchObject({
        _tag: "PreviewOperationError",
        operation: "getBrowserPartition",
      });
      expect(failedError(yield* Effect.exit(manager.clearCookies()))).toMatchObject({
        _tag: "PreviewOperationError",
        operation: "clearCookies",
        cause: storageError,
      });
      expect(failedError(yield* Effect.exit(manager.clearCache()))).toMatchObject({
        _tag: "PreviewOperationError",
        operation: "clearCache",
        cause: cacheError,
      });
    }).pipe(Effect.provide(failingLayer), Effect.scoped);
  });
});

describe("PreviewManager error surfaces", () => {
  it("renders structured messages for tab and webview errors", () => {
    expect(new PreviewManager.PreviewTabNotFoundError({ tabId: "tab_x" }).message).toBe(
      "Preview tab not found: tab_x",
    );
    expect(
      new PreviewManager.PreviewWebContentsNotFoundError({ tabId: "tab_x", webContentsId: 9 })
        .message,
    ).toBe("WebContents 9 not found for preview tab tab_x");
    expect(new PreviewManager.PreviewWebviewNotInitializedError({ tabId: "tab_x" }).message).toBe(
      'Preview tab "tab_x" has no webview registered',
    );
    expect(
      new PreviewManager.PreviewArtifactImageLoadError({ artifactPath: "/tmp/a.png" }).message,
    ).toBe("Preview artifact could not be loaded as an image: /tmp/a.png");
    expect(
      new PreviewManager.PreviewRecordingAlreadyActiveError({
        requestedTabId: "tab_b",
        activeTabId: "tab_a",
      }).message,
    ).toBe("Cannot record preview tab tab_b while tab tab_a is already recording");
    expect(
      new PreviewManager.PreviewAutomationDevToolsOpenError({ webContentsId: 4 }).message,
    ).toBe("Close preview DevTools before using agent browser control for WebContents 4");
    expect(
      new PreviewManager.PreviewAutomationDebuggerAttachedError({ webContentsId: 4 }).message,
    ).toBe("Preview control cannot attach to WebContents 4 because another debugger owns it");
  });

  it("labels automation targets by selector kind", () => {
    expect(
      new PreviewManager.PreviewAutomationTargetNotEditableError({
        tabId: "tab_x",
        selectorKind: "focused-element",
      }).message,
    ).toBe(
      "Preview automation type found the focused element, but it is not editable in tab tab_x",
    );
    expect(
      new PreviewManager.PreviewAutomationTargetNotEditableError({
        tabId: "tab_x",
        selectorKind: "selector",
        selectorLength: 5,
      }).message,
    ).toBe(
      "Preview automation type found selector (5 characters), but it is not editable in tab tab_x",
    );
    expect(
      new PreviewManager.PreviewAutomationCoordinatesOutsideViewportError({
        tabId: "tab_x",
        x: 900,
        y: 20,
        viewportWidth: 800,
        viewportHeight: 600,
      }).message,
    ).toBe("Click coordinates (900, 20) are outside the 800x600 preview viewport for tab tab_x");
    expect(
      new PreviewManager.PreviewAutomationTimeoutError({ tabId: "tab_x", timeoutMs: 500 }).message,
    ).toBe("Preview condition did not match within 500ms in tab tab_x");
    expect(
      new PreviewManager.PreviewAutomationControlInterruptedError({
        operation: "click",
        tabId: "tab_x",
        webContentsId: 3,
      }).message,
    ).toBe("Preview automation click was interrupted by human input in tab tab_x");
  });

  it("falls back to structural messages for malformed selector causes", () => {
    const nonObjectCause = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_x",
      selectorKind: "locator",
      selectorLength: 3,
      reasonLength: 0,
      cause: "not-an-object",
    });
    expect(
      PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(nonObjectCause),
    ).toBe(nonObjectCause.message);

    const emptyReason = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_x",
      selectorKind: "selector",
      reasonLength: 0,
      cause: { invalidSelector: true, message: "" },
    });
    expect(
      PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(emptyReason),
    ).toBe(emptyReason.message);
    expect(emptyReason.detail).toEqual({ selectorKind: "selector" });

    const tooLarge = new PreviewManager.PreviewAutomationResultTooLargeError({
      tabId: "tab_x",
      actualBytes: 70_000,
      maximumBytes: 64_000,
    });
    expect(tooLarge.detail).toEqual({ maximumBytes: 64_000 });
    expect(tooLarge.message).toBe(
      "Preview evaluation result in tab tab_x was 70000 bytes; maximum is 64000 bytes",
    );

    const operationError = new PreviewManager.PreviewOperationError({
      operation: "navigate",
      cause: "string cause",
    });
    expect(operationError.message).toBe("Desktop preview operation failed: navigate");
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(operationError)).toBe(
      "string cause",
    );
    const contextualError = new PreviewManager.PreviewOperationError({
      operation: "capture",
      tabId: "tab_x",
      webContentsId: 5,
      artifactPath: "/tmp/a.png",
      cause: new Error("boom"),
    });
    expect(contextualError.message).toBe(
      "Desktop preview operation failed: capture (tab tab_x, WebContents 5, artifact /tmp/a.png)",
    );

    expect(PreviewManager.isPreviewManagerError(tooLarge)).toBe(true);
    expect(PreviewManager.isPreviewManagerError(new Error("plain"))).toBe(false);
    const evaluationError = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: "tab_x",
      detailKind: "unknown",
      detailLength: 0,
      cause: null,
    });
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(evaluationError)).toBe(
      evaluationError.message,
    );
  });
});
