import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { events, onFrame, registrySet, save, startScreencast, stopScreencast, surfaceState } =
  vi.hoisted(() => {
    const events: string[] = [];
    const surfaceState = {
      byTabId: {} as Record<string, unknown>,
    };
    return {
      events,
      onFrame: vi.fn((_callback: (frame: { tabId: string; data: string }) => void) => vi.fn()),
      registrySet: vi.fn((_atom: unknown, value: string | null) => {
        events.push(value === null ? "clear" : `publish:${value}`);
      }),
      save: vi.fn(async () => ({
        id: "recording-test",
        tabId: "recording-tab",
        path: "/tmp/recording-test.webm",
        mimeType: "video/webm" as const,
        sizeBytes: 0,
        createdAt: "2026-06-26T00:00:00.000Z",
      })),
      startScreencast: vi.fn(async () => {
        events.push("start-screencast");
      }),
      stopScreencast: vi.fn(async () => undefined),
      surfaceState,
    };
  });

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    recording: { onFrame, save, startScreencast, stopScreencast },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("./browserSurfaceStore", () => ({
  useBrowserSurfaceStore: {
    getState: () => surfaceState,
  },
}));

import {
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserRecordingConflictError,
  BrowserRecordingCanvasUnavailableError,
  BrowserRecordingOperationError,
  BrowserRecordingRequiresVisibleTabError,
  readActiveBrowserRecordingTabId,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";

class FakeMediaRecorder {
  static supportedTypes = new Set(["video/mp4;codecs=avc1.42E01E"]);
  static startError: unknown;
  static stopError: unknown;

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supportedTypes.has(type);
  }

  state: RecordingState = "inactive";
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    if (FakeMediaRecorder.startError) throw FakeMediaRecorder.startError;
    this.state = "recording";
  }

  stop(): void {
    if (FakeMediaRecorder.stopError) throw FakeMediaRecorder.stopError;
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      if (typeof listener === "function") listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

describe("browser recording", () => {
  let frameCallback: ((frame: { tabId: string; data: string }) => void) | undefined;
  let drawImage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    events.length = 0;
    surfaceState.byTabId = {
      "recording-tab": {
        visible: true,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    };
    vi.clearAllMocks();
    FakeMediaRecorder.supportedTypes = new Set(["video/mp4;codecs=avc1.42E01E"]);
    FakeMediaRecorder.startError = undefined;
    FakeMediaRecorder.stopError = undefined;
    drawImage = vi.fn();
    onFrame.mockImplementation((callback) => {
      frameCallback = callback;
      return vi.fn();
    });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        captureStream: () => ({}),
        getContext: () => ({ drawImage }),
      }),
    });
    vi.stubGlobal(
      "Image",
      class FakeImage {
        private load: (() => void) | undefined;
        addEventListener(_type: string, listener: () => void): void {
          this.load = listener;
        }
        set src(_value: string) {
          this.load?.();
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts recording for a visible tab", async () => {
    expect(readActiveBrowserRecordingTabId()).toBeNull();
    await startBrowserRecording("recording-tab");

    expect(events).toEqual(["start-screencast", "publish:recording-tab"]);
    expect(readActiveBrowserRecordingTabId()).toBe("recording-tab");

    const firstStartedAt = await startBrowserRecording("recording-tab");
    expect(firstStartedAt).toMatch(/^\d{4}-/);

    await stopBrowserRecording("recording-tab");
    expect(readActiveBrowserRecordingTabId()).toBeNull();
  });

  it("draws only matching frames while the recording remains active", async () => {
    await startBrowserRecording("recording-tab");

    frameCallback?.({ tabId: "another-tab", data: "ignored" });
    frameCallback?.({ tabId: "recording-tab", data: "frame" });
    expect(drawImage).toHaveBeenCalledOnce();

    await stopBrowserRecording("recording-tab");
    frameCallback?.({ tabId: "recording-tab", data: "late-frame" });
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it("uses rect and default dimensions when content sizing is absent", async () => {
    surfaceState.byTabId = {
      "recording-tab": { visible: true, rect: { x: 0, y: 0, width: 0, height: -1 } },
    };
    const canvases: Array<{ width: number; height: number }> = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          captureStream: () => ({}),
          getContext: () => ({ drawImage }),
        };
        canvases.push(canvas);
        return canvas;
      },
    });

    await startBrowserRecording("recording-tab");
    expect(canvases[0]).toMatchObject({ width: 1, height: 1 });
    await stopBrowserRecording("recording-tab");

    surfaceState.byTabId = { "recording-tab": { visible: true } };
    await startBrowserRecording("recording-tab");
    expect(canvases[1]).toMatchObject({ width: 1280, height: 800 });
    await stopBrowserRecording("recording-tab");
  });

  it("falls through supported mime types and defaults to webm", async () => {
    FakeMediaRecorder.supportedTypes = new Set(["video/webm;codecs=vp9"]);
    await startBrowserRecording("recording-tab");
    await stopBrowserRecording("recording-tab");
    expect(save).toHaveBeenLastCalledWith(
      "recording-tab",
      "video/webm;codecs=vp9",
      expect.any(Uint8Array),
    );

    FakeMediaRecorder.supportedTypes.clear();
    await startBrowserRecording("recording-tab");
    await stopBrowserRecording("recording-tab");
    expect(save).toHaveBeenLastCalledWith("recording-tab", "video/webm", expect.any(Uint8Array));
  });

  it("reports missing canvases and recorder initialization failures", async () => {
    vi.stubGlobal("document", {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    });
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingCanvasUnavailableError,
    );

    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        captureStream: () => {
          throw new Error("capture failed");
        },
      }),
    });
    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "initialize-media-recorder",
    });
  });

  it("cleans up frame subscriptions and recorder start failures", async () => {
    onFrame.mockImplementationOnce(() => {
      throw new Error("subscribe failed");
    });
    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "subscribe-frames",
    });
    expect(readActiveBrowserRecordingTabId()).toBeNull();

    FakeMediaRecorder.startError = new Error("start failed");
    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "start-media-recorder",
    });
    expect(readActiveBrowserRecordingTabId()).toBeNull();
  });

  it("cleans up when screencast startup fails, including recorder stop failures", async () => {
    startScreencast.mockRejectedValueOnce(new Error("screencast failed"));
    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "start-screencast",
      cause: expect.any(Error),
    });
    expect(readActiveBrowserRecordingTabId()).toBeNull();

    startScreencast.mockRejectedValueOnce(new Error("screencast failed again"));
    FakeMediaRecorder.stopError = new Error("recorder stop failed");
    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "start-screencast",
      cause: expect.any(AggregateError),
    });
    expect(readActiveBrowserRecordingTabId()).toBeNull();
  });

  it("reports screencast, recorder, and artifact failures while stopping", async () => {
    await expect(stopBrowserRecording("recording-tab")).resolves.toBeNull();

    await startBrowserRecording("recording-tab");
    stopScreencast.mockRejectedValueOnce(new Error("stop screencast failed"));
    await expect(stopBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "stop-screencast",
    });
    expect(readActiveBrowserRecordingTabId()).toBeNull();

    await startBrowserRecording("recording-tab");
    save.mockRejectedValueOnce(new Error("save failed"));
    await expect(stopBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "save-artifact",
    });
    expect(readActiveBrowserRecordingTabId()).toBeNull();

    await startBrowserRecording("recording-tab");
    FakeMediaRecorder.stopError = new Error("stop recorder failed");
    await expect(stopBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "cleanup",
      cause: expect.any(AggregateError),
    });
    expect(readActiveBrowserRecordingTabId()).toBeNull();
  });

  it("rejects recording for a hidden tab before starting screencast", async () => {
    surfaceState.byTabId = {
      "recording-tab": {
        visible: false,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    };

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingRequiresVisibleTabError,
    );

    expect(startScreencast).not.toHaveBeenCalled();
    expect(registrySet).not.toHaveBeenCalled();
  });

  it("does not report success for a second start while the first is still starting", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await firstStart;
    await stopBrowserRecording("recording-tab");
  });

  it("does not report success for a start while the recording is stopping", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });
      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStoppingScreencast?.();
    await stopPromise;
  });

  it("shares an in-progress stop with duplicate callers", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });
      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const firstStop = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    const duplicateStop = stopBrowserRecording("recording-tab");

    finishStoppingScreencast?.();
    const [firstArtifact, duplicateArtifact] = await Promise.all([firstStop, duplicateStop]);

    expect(duplicateArtifact).toEqual(firstArtifact);
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("stops a screencast that finishes starting after cancellation", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    finishStartingScreencast?.();

    await rejectedStart;
    await stopPromise;
    expect(stopScreencast).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toBe("clear");
  });

  it("does not release the recording slot until a cancelled start settles", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const firstStart = startBrowserRecording("recording-tab");
    const rejectedFirstStart = expect(firstStart).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const restartAfterStop = stopPromise.then(() => startBrowserRecording("recording-tab"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startCallsBeforeFirstSettled = startScreencast.mock.calls.length;

    finishStartingScreencast?.();
    await rejectedFirstStart;
    await stopPromise;
    await restartAfterStop;
    await stopBrowserRecording("recording-tab");

    expect(startCallsBeforeFirstSettled).toBe(1);
  });

  it("fails a stop that waits too long for startup without freeing the recording slot", async () => {
    vi.useFakeTimers();
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    expect(startScreencast).toHaveBeenCalledOnce();

    const stopPromise = stopBrowserRecording("recording-tab");
    await Promise.resolve();
    await Promise.resolve();
    expect(stopScreencast).toHaveBeenCalledOnce();

    const rejection = expect(stopPromise).rejects.toMatchObject({
      operation: "wait-startup",
      tabId: "recording-tab",
    });
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);

    await rejection;
    expect(save).not.toHaveBeenCalled();
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await rejectedStart;
    const cleanupResult = await stopBrowserRecording("recording-tab");
    expect(cleanupResult).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("clear");
  });
});
