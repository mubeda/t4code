import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  useServerSnapshot: false,
  subscribe: true,
  callback: vi.fn(),
  cleanup: null as (() => void) | null,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (
    subscribe: (callback: () => void) => () => void,
    getSnapshot: () => boolean,
    getServerSnapshot: () => boolean,
  ) => {
    if (h.subscribe) {
      h.cleanup = subscribe(h.callback);
    }
    return h.useServerSnapshot ? getServerSnapshot() : getSnapshot();
  },
}));

import { useIsMobile, useMediaQuery } from "./useMediaQuery";

beforeEach(() => {
  h.useServerSnapshot = false;
  h.subscribe = true;
  h.callback.mockClear();
  h.cleanup = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function installMatchMedia(matches = true) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const matchMedia = vi.fn((media: string) => ({
    media,
    matches,
    addEventListener,
    removeEventListener,
  }));
  vi.stubGlobal("window", { matchMedia });
  return { addEventListener, matchMedia, removeEventListener };
}

describe("useMediaQuery", () => {
  it("builds breakpoint, range, and raw media queries", () => {
    const media = installMatchMedia();

    expect(useMediaQuery("md")).toBe(true);
    expect(useMediaQuery("max-lg")).toBe(true);
    expect(useMediaQuery("sm:max-xl")).toBe(true);
    expect(useMediaQuery("(prefers-reduced-motion: reduce)")).toBe(true);
    expect(useMediaQuery("screen and (color)")).toBe(true);
    expect(useIsMobile()).toBe(true);

    expect(media.matchMedia.mock.calls.map(([query]) => query)).toEqual(
      expect.arrayContaining([
        "(min-width: 768px)",
        "(max-width: 1023px)",
        "(min-width: 640px) and (max-width: 1279px)",
        "(prefers-reduced-motion: reduce)",
        "screen and (color)",
        "(max-width: 767px)",
      ]),
    );
  });

  it("builds object queries from numeric and named limits and pointer kinds", () => {
    const media = installMatchMedia(false);

    expect(useMediaQuery({ min: 500, max: 900, pointer: "coarse" })).toBe(false);
    expect(useMediaQuery({ min: "lg", max: "2xl", pointer: "fine" })).toBe(false);
    expect(useMediaQuery({})).toBe(false);

    expect(media.matchMedia.mock.calls.map(([query]) => query)).toEqual(
      expect.arrayContaining([
        "(min-width: 500px) and (max-width: 899px) and (pointer: coarse)",
        "(min-width: 1024px) and (max-width: 1535px) and (pointer: fine)",
        "(min-width: 0px)",
      ]),
    );
  });

  it("subscribes to media changes and removes the listener during cleanup", () => {
    const media = installMatchMedia();

    useMediaQuery("3xl");
    expect(media.addEventListener).toHaveBeenCalledWith("change", h.callback);

    h.cleanup?.();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", h.callback);
  });

  it("uses false snapshots and a no-op subscription without a browser window", () => {
    vi.stubGlobal("window", undefined);

    expect(useMediaQuery("4xl")).toBe(false);
    expect(() => h.cleanup?.()).not.toThrow();

    h.useServerSnapshot = true;
    expect(useMediaQuery({ pointer: "coarse" })).toBe(false);
  });
});
