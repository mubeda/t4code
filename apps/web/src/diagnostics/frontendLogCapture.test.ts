import { describe, expect, it, vi } from "vite-plus/test";

import { createFrontendLogCapture, type FrontendLogEventTarget } from "./frontendLogCapture";

function fakeEventTarget() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const target: FrontendLogEventTarget = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
  };
  return {
    target,
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.length ?? 0;
    },
  };
}

function fakeConsole() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("frontend log capture", () => {
  it("records warn and error while preserving native console calls", () => {
    const capture = createFrontendLogCapture({
      maxBytes: 4_096,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const consoleTarget = fakeConsole();
    const nativeWarn = consoleTarget.warn;
    const nativeError = consoleTarget.error;
    const events = fakeEventTarget();
    capture.install({ console: consoleTarget, eventTarget: events.target });

    consoleTarget.log("ignored");
    consoleTarget.info("ignored");
    consoleTarget.debug("ignored");
    consoleTarget.warn("slow", 42);
    consoleTarget.error(new Error("boom"));

    expect(nativeWarn).toHaveBeenCalledWith("slow", 42);
    expect(nativeError).toHaveBeenCalledTimes(1);
    expect(capture.snapshot()).toContain("[2026-07-15T12:00:00.000Z] console.warn slow 42");
    expect(capture.snapshot()).toContain("console.error Error: boom");
    expect(capture.snapshot()).not.toContain("ignored");
  });

  it("records uncaught errors and unhandled rejections", () => {
    const capture = createFrontendLogCapture({
      maxBytes: 4_096,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const events = fakeEventTarget();
    capture.install({ console: fakeConsole(), eventTarget: events.target });

    events.dispatch("error", { error: new TypeError("uncaught") });
    events.dispatch("unhandledrejection", { reason: new Error("rejected") });

    expect(capture.snapshot()).toContain("window.error TypeError: uncaught");
    expect(capture.snapshot()).toContain("window.unhandledrejection Error: rejected");
  });

  it("survives circular and hostile values while redacting credentials", () => {
    const capture = createFrontendLogCapture({ maxBytes: 8_192 });
    const consoleTarget = fakeConsole();
    const events = fakeEventTarget();
    capture.install({ console: consoleTarget, eventTarget: events.target });
    const circular: Record<string, unknown> = {
      authorization: "Bearer top-secret",
      apiKey: "client-secret",
    };
    circular.self = circular;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    expect(() => consoleTarget.error(circular, hostile)).not.toThrow();
    const snapshot = capture.snapshot();
    expect(snapshot).toContain("[Circular]");
    expect(snapshot).toContain("[Unserializable]");
    expect(snapshot).toContain("[REDACTED]");
    expect(snapshot).not.toContain("top-secret");
    expect(snapshot).not.toContain("client-secret");
  });

  it("evicts complete oldest records to stay within the UTF-8 byte limit", () => {
    const capture = createFrontendLogCapture({ maxBytes: 150 });
    const consoleTarget = fakeConsole();
    const events = fakeEventTarget();
    capture.install({ console: consoleTarget, eventTarget: events.target });

    consoleTarget.warn("first-record", "🙂🙂🙂🙂");
    consoleTarget.warn("second-record", "🙂🙂🙂🙂");
    consoleTarget.warn("third-record", "🙂🙂🙂🙂");

    const snapshot = capture.snapshot();
    expect(new TextEncoder().encode(snapshot).byteLength).toBeLessThanOrEqual(150);
    expect(snapshot).not.toContain("first-record");
    expect(snapshot).toContain("third-record");
    expect(snapshot.endsWith("\n")).toBe(true);
  });

  it("installs wrappers and global listeners only once", () => {
    const capture = createFrontendLogCapture({ maxBytes: 4_096 });
    const consoleTarget = fakeConsole();
    const events = fakeEventTarget();

    capture.install({ console: consoleTarget, eventTarget: events.target });
    const installedWarn = consoleTarget.warn;
    capture.install({ console: consoleTarget, eventTarget: events.target });
    consoleTarget.warn("once");

    expect(consoleTarget.warn).toBe(installedWarn);
    expect(events.listenerCount("error")).toBe(1);
    expect(events.listenerCount("unhandledrejection")).toBe(1);
    expect(capture.snapshot().match(/console\.warn/g)).toHaveLength(1);
  });
});
