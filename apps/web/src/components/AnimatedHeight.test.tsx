import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  element: null as {
    scrollHeight: number;
    getBoundingClientRect: ReturnType<typeof vi.fn>;
  } | null,
  heightState: { height: null as number | null, isClipping: false },
  setHeightState: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
  layoutEffects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) => harness.layoutEffects.push(effect),
  useRef: () => ({ current: harness.element }),
  useState: () => [harness.heightState, harness.setHeightState],
}));

import { AnimatedHeight } from "./AnimatedHeight";

beforeEach(() => {
  harness.element = null;
  harness.heightState = { height: null, isClipping: false };
  harness.setHeightState.mockReset();
  harness.effects.length = 0;
  harness.layoutEffects.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnimatedHeight", () => {
  it("renders its unmeasured state and skips effects without work", () => {
    const tree = AnimatedHeight({ children: "Content" });
    expect(tree.props.style).toBeUndefined();
    expect(harness.effects[0]?.()).toBeUndefined();
    expect(harness.layoutEffects[0]?.()).toBeUndefined();
  });

  it("measures after paint, reacts to resizes, and cancels pending frames", () => {
    const frameCallbacks: Array<FrameRequestCallback> = [];
    let nextFrameId = 0;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("window", { requestAnimationFrame, cancelAnimationFrame });

    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );

    harness.element = {
      scrollHeight: 0,
      getBoundingClientRect: vi.fn(() => ({ height: 4.2 })),
    };
    AnimatedHeight({ children: "Measured" });
    const cleanup = harness.layoutEffects[0]?.();
    expect(observe).toHaveBeenCalledWith(harness.element);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    const firstUpdate = harness.setHeightState.mock.calls[0]?.[0] as
      | ((state: { height: number | null; isClipping: boolean }) => unknown)
      | undefined;
    expect(firstUpdate?.({ height: null, isClipping: false })).toEqual({
      height: 5,
      isClipping: false,
    });
    const sameState = { height: 5, isClipping: true };
    expect(firstUpdate?.(sameState)).toBe(sameState);
    expect(firstUpdate?.({ height: 1, isClipping: false })).toEqual({
      height: 5,
      isClipping: true,
    });

    frameCallbacks.shift()?.(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    harness.element.scrollHeight = 7;
    resizeCallback?.([], {} as ResizeObserver);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
    frameCallbacks.shift()?.(0);

    if (typeof cleanup === "function") cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(3);
  });

  it("clears clipping after a timeout or height transition", () => {
    let timeoutCallback: (() => void) | undefined;
    const setTimeout = vi.fn((callback: () => void) => {
      timeoutCallback = callback;
      return 12;
    });
    const clearTimeout = vi.fn();
    vi.stubGlobal("window", { setTimeout, clearTimeout });

    harness.heightState = { height: 42, isClipping: true };
    const tree = AnimatedHeight({ children: "Clipped" });
    expect(tree.props.style).toEqual({ height: 42, overflow: "hidden" });
    const cleanup = harness.effects[0]?.();
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
    timeoutCallback?.();
    const timeoutUpdate = harness.setHeightState.mock.calls[0]?.[0] as
      | ((state: { height: number | null; isClipping: boolean }) => unknown)
      | undefined;
    expect(timeoutUpdate?.({ height: 42, isClipping: true })).toEqual({
      height: 42,
      isClipping: false,
    });
    const settled = { height: 42, isClipping: false };
    expect(timeoutUpdate?.(settled)).toBe(settled);
    if (typeof cleanup === "function") cleanup();
    expect(clearTimeout).toHaveBeenCalledWith(12);

    const onTransitionEnd = tree.props.onTransitionEnd as (event: unknown) => void;
    const currentTarget = {};
    onTransitionEnd({ target: {}, currentTarget, propertyName: "height" });
    onTransitionEnd({ target: currentTarget, currentTarget, propertyName: "opacity" });
    expect(harness.setHeightState).toHaveBeenCalledTimes(1);
    onTransitionEnd({ target: currentTarget, currentTarget, propertyName: "height" });
    expect(harness.setHeightState).toHaveBeenCalledTimes(2);
    const transitionUpdate = harness.setHeightState.mock.calls[1]?.[0] as
      | ((state: { height: number | null; isClipping: boolean }) => unknown)
      | undefined;
    expect(transitionUpdate?.({ height: 42, isClipping: true })).toEqual({
      height: 42,
      isClipping: false,
    });
    expect(transitionUpdate?.(settled)).toBe(settled);

    harness.effects.length = 0;
    harness.layoutEffects.length = 0;
    harness.heightState = { height: 42, isClipping: false };
    const visible = AnimatedHeight({ children: React.createElement("span") });
    expect(visible.props.style).toEqual({ height: 42, overflow: "visible" });
  });
});
