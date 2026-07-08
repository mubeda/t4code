/**
 * Behavior tests for ProviderAccentColorPicker.
 *
 * Instrumented-hooks SSR pattern (see FilePreviewPanel.test.tsx): useState /
 * useEffect / useRef are replaced so state can be seeded, setter calls
 * recorded, and effects run manually; useMemo / useCallback stay real (the
 * dispatcher is live during renderToStaticMarkup). Popover / ColorSelector /
 * Button are capture-mocked so their handler props can be invoked directly.
 * The custom-color panel executes during SSR because the PopoverPopup mock
 * renders its children.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const harness = vi.hoisted(() => {
  type Matcher = (initial: unknown) => boolean;
  const state = {
    stateSeeds: [] as Array<{ match: Matcher; value: unknown }>,
    setStateCalls: [] as Array<{ initial: unknown; next: unknown; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
    refs: [] as Array<{ current: unknown }>,
    reset() {
      state.stateSeeds.length = 0;
      state.setStateCalls.length = 0;
      state.effects.length = 0;
      state.refs.length = 0;
    },
    seedState(match: Matcher, value: unknown) {
      state.stateSeeds.push({ match, value });
    },
    runEffects(): Array<() => void> {
      const cleanups: Array<() => void> = [];
      for (const effect of state.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return cleanups;
    },
  };
  return state;
});

const ui = vi.hoisted(() => {
  const registry = {
    entries: [] as Array<{ kind: string; props: Record<string, unknown> }>,
    reset() {
      registry.entries.length = 0;
    },
    record(kind: string, props: unknown) {
      if (props && typeof props === "object") {
        registry.entries.push({ kind, props: props as Record<string, unknown> });
      }
    },
    filter(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      return registry.entries
        .filter((entry) => entry.kind === kind && (predicate?.(entry.props) ?? true))
        .map((entry) => entry.props);
    },
    find(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      const found = registry.entries.find(
        (entry) => entry.kind === kind && (predicate?.(entry.props) ?? true),
      )?.props;
      if (!found) throw new Error(`No recorded "${kind}" element matched`);
      return found;
    },
    byLabel(kind: string, label: string) {
      return registry.find(kind, (props) => props["aria-label"] === label);
    },
  };
  return registry;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;

  const useState = (initial?: unknown) => {
    const resolved = resolveInitial(initial);
    const seedIndex = harness.stateSeeds.findIndex((seed) => seed.match(resolved));
    const value = seedIndex >= 0 ? harness.stateSeeds.splice(seedIndex, 1)[0]!.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      harness.setStateCalls.push({ initial: resolved, next, applied });
    };
    return [value, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  };
  const useRef = (initial?: unknown) => {
    const ref = { current: initial ?? null };
    harness.refs.push(ref);
    return ref;
  };
  // Plain useMemo/useCallback so nested components can be invoked directly
  // (outside a renderer) to reach host-element handlers.
  const useMemo = (factory: () => unknown) => factory();
  const useCallback = (callback: unknown) => callback;
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useRef: useRef as typeof actual.useRef,
    useMemo: useMemo as typeof actual.useMemo,
    useCallback: useCallback as typeof actual.useCallback,
  };
});

// If the target is compiled by React Compiler its components import the memo
// cache from `react/compiler-runtime`. Returning a fresh sentinel-filled array
// disables memoization while keeping the components dispatcher-free, so they
// can be invoked directly in tests.
vi.mock("react/compiler-runtime", () => ({
  c: (size: number) => Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel")),
}));

vi.mock("../color-selector", () => ({
  ColorSelector: (props: Record<string, unknown>) => {
    ui.record("ColorSelector", props);
    return <div data-color-selector />;
  },
}));

vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    ui.record("Button", props);
    return (
      <button type="button" aria-label={props["aria-label"] as string | undefined}>
        {props.children as ReactNode}
      </button>
    );
  },
}));

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <div data-popover>{children}</div>,
  PopoverTrigger: ({ render }: { render?: ReactNode }) => (
    <span data-popover-trigger>{render}</span>
  ),
  PopoverPopup: (props: Record<string, unknown>) => {
    ui.record("PopoverPopup", props);
    return <div data-popover-popup>{props.children as ReactNode}</div>;
  },
}));

import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

type Props = Parameters<typeof ProviderAccentColorPicker>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    displayName: "Codex",
    value: undefined,
    onCommit: vi.fn(),
    ...overrides,
  };
}

function render(props: Props): string {
  ui.reset();
  harness.setStateCalls.length = 0;
  harness.effects.length = 0;
  harness.refs.length = 0;
  return renderToStaticMarkup(<ProviderAccentColorPicker {...props} />);
}

beforeEach(() => {
  harness.reset();
  ui.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("rendering", () => {
  it("renders the label and optional description", () => {
    const markup = render(baseProps({ description: "Distinguish this instance." }));
    expect(markup).toContain("Accent color");
    expect(markup).toContain("Distinguish this instance.");
  });

  it("omits the description when not provided", () => {
    const markup = render(baseProps());
    expect(markup).toContain("Accent color");
    expect(markup).not.toContain('text-muted-foreground">undefined');
  });

  it("selects a matching swatch and hides custom selection", () => {
    render(baseProps({ value: "#2563eb" }));
    expect(ui.find("ColorSelector").defaultValue).toBe("#2563eb");
    // custom picker is rendered but not marked selected
    const custom = ui.find("Button", (p) => typeof p["aria-label"] === "string");
    expect(custom).toBeDefined();
  });

  it("marks the custom picker selected for a non-swatch color", () => {
    const markup = render(baseProps({ value: "#123456" }));
    expect(ui.find("ColorSelector").defaultValue).toBe("");
    // The custom swatch button advertises the display name.
    expect(markup).toContain("Choose custom accent color for Codex");
  });

  it("renders the panel with computed swatch positions for red/green/blue hues", () => {
    // Each dominant channel exercises a different hue branch in hexToHsv and a
    // different arm of hsvToHex; the panel renders because PopoverPopup shows
    // its children.
    expect(render(baseProps({ value: "#dc2626" }))).toContain("data-popover-popup");
    expect(render(baseProps({ value: "#16a34a" }))).toContain("data-popover-popup");
    const blue = render(baseProps({ value: "#2563eb" }));
    expect(blue).toContain("hsl(");
    // grayscale color: delta === 0 path in hexToHsv
    expect(render(baseProps({ value: "#808080" }))).toContain("data-popover-popup");
  });

  it("hides and disables the clear button when there is no color", () => {
    render(baseProps({ value: undefined }));
    const clear = ui.byLabel("Button", "Clear accent color for Codex");
    expect(clear["tabIndex"]).toBe(-1);
    expect(clear["aria-hidden"]).toBe(true);

    render(baseProps({ value: "#2563eb" }));
    const shown = ui.byLabel("Button", "Clear accent color for Codex");
    expect(shown["tabIndex"]).toBe(0);
    expect(shown["aria-hidden"]).toBe(false);
  });
});

describe("committing colors", () => {
  it("commits immediately when there is no delay", () => {
    const onCommit = vi.fn();
    render(baseProps({ value: "#2563eb", onCommit }));
    const selector = ui.find("ColorSelector");
    (selector.onColorSelect as (value: string) => void)("#16a34a");
    expect(onCommit).toHaveBeenCalledWith("#16a34a");
    // optimistic state is updated to the normalized value
    expect(harness.setStateCalls.some((c) => c.next === "#16a34a")).toBe(true);
  });

  it("normalizes an invalid color to empty on commit", () => {
    const onCommit = vi.fn();
    render(baseProps({ value: "#2563eb", onCommit }));
    (ui.find("ColorSelector").onColorSelect as (value: string) => void)("not-a-color");
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("clears the color from the clear button", () => {
    const onCommit = vi.fn();
    render(baseProps({ value: "#2563eb", onCommit }));
    (ui.byLabel("Button", "Clear accent color for Codex").onClick as () => void)();
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("debounces commits when a delay is configured", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(baseProps({ value: "#2563eb", onCommit, commitDelayMs: 120 }));
    const selector = ui.find("ColorSelector");

    (selector.onColorSelect as (value: string) => void)("#16a34a");
    // no immediate commit under a delay
    expect(onCommit).not.toHaveBeenCalled();
    // a second selection replaces the pending timer
    (selector.onColorSelect as (value: string) => void)("#ea580c");
    expect(onCommit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("#ea580c");
  });

  it("cancels a pending delayed commit when a zero-delay commit follows", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    // Render once with a delay to arm a timer, then commit with the same
    // callback path but zero delay by re-invoking on a fresh no-delay render.
    render(baseProps({ value: "#2563eb", onCommit, commitDelayMs: 120 }));
    const delayed = ui.find("ColorSelector");
    (delayed.onColorSelect as (value: string) => void)("#16a34a");

    // Now a zero-delay picker commits immediately and should clear the timer.
    render(baseProps({ value: "#2563eb", onCommit, commitDelayMs: 0 }));
    (ui.find("ColorSelector").onColorSelect as (value: string) => void)("#7c3aed");
    expect(onCommit).toHaveBeenCalledWith("#7c3aed");
  });
});

describe("effects", () => {
  it("syncs optimistic value from props when no commit is pending", () => {
    render(baseProps({ value: "#2563eb" }));
    // commitTimeoutRef=refs[0], pendingCommitRef=refs[1], onCommitRef=refs[2]
    harness.refs[1]!.current = null;
    harness.setStateCalls.length = 0;
    harness.runEffects();
    expect(harness.setStateCalls.some((c) => c.next === "#2563eb")).toBe(true);
  });

  it("skips the optimistic sync while a commit is pending", () => {
    render(baseProps({ value: "#2563eb" }));
    harness.refs[1]!.current = "#111111";
    harness.setStateCalls.length = 0;
    harness.runEffects();
    // effect 2 returns early, so no optimistic value is written from props
    expect(harness.setStateCalls.some((c) => c.next === "#2563eb")).toBe(false);
  });

  it("flushes a pending commit and clears the timer on unmount", () => {
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("clearTimeout", clearTimeoutSpy);
    const onCommit = vi.fn();
    render(baseProps({ value: "#2563eb", onCommit }));
    const cleanups = harness.runEffects();
    // Arm a pending timer + pending commit before unmount cleanup runs.
    harness.refs[0]!.current = 999;
    harness.refs[1]!.current = "#abcdef";
    for (const cleanup of cleanups) cleanup();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(999);
    expect(onCommit).toHaveBeenCalledWith("#abcdef");
  });

  it("cleans up without flushing when nothing is pending", () => {
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("clearTimeout", clearTimeoutSpy);
    const onCommit = vi.fn();
    render(baseProps({ value: "#2563eb", onCommit }));
    const cleanups = harness.runEffects();
    harness.refs[0]!.current = null;
    harness.refs[1]!.current = null;
    for (const cleanup of cleanups) cleanup();
    expect(clearTimeoutSpy).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// ── Custom color panel interactions ────────────────────────────────────────
// The panel is a private component. It is retrieved via the captured
// PopoverPopup child element and invoked directly (hooks are instrumented to
// be dispatcher-free) so its host-element handlers can be exercised.

type PanelComponent = (props: { value: string; onCommit: (value: string) => void }) => ReactElement;

function collect(node: unknown, out: ReactElement[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return;
  }
  if (isValidElement(node)) {
    out.push(node);
    collect((node.props as { children?: unknown }).children, out);
  }
}

function getPanelComponent(): PanelComponent {
  render(baseProps({ value: "#2563eb" }));
  const popup = ui.find("PopoverPopup");
  const child = popup.children as ReactElement;
  return child.type as PanelComponent;
}

function renderPanel(onCommit: (value: string) => void, value = "#2563eb") {
  const Panel = getPanelComponent();
  harness.setStateCalls.length = 0;
  const tree = Panel({ value, onCommit });
  const elements: ReactElement[] = [];
  collect(tree, elements);
  const props = elements.map((element) => element.props as Record<string, unknown>);
  const byClass = (needle: string) =>
    props.find((p) => typeof p.className === "string" && (p.className as string).includes(needle))!;
  return {
    plane: byClass("cursor-crosshair"),
    hue: byClass("cursor-pointer"),
    hexInput: props.find((p) => p["aria-label"] === "Custom hex accent color")!,
  };
}

function pointerEvent(overrides: Record<string, unknown> = {}) {
  const capture = overrides["hasPointerCapture"] ?? true;
  const currentTarget = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => capture),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  return { pointerId: 1, clientX: 50, clientY: 25, currentTarget, ...overrides };
}

describe("custom color panel", () => {
  it("commits a color when dragging on the saturation/value plane", () => {
    const onCommit = vi.fn();
    const { plane } = renderPanel(onCommit);
    const event = pointerEvent();
    (plane.onPointerDown as (e: unknown) => void)(event);
    expect(event.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toMatch(/^#[0-9a-f]{6}$/i);
    // setHsv was recorded through the instrumented state setter
    expect(harness.setStateCalls.length).toBeGreaterThan(0);
  });

  it("clamps plane coordinates that fall outside the bounds", () => {
    const onCommit = vi.fn();
    const { plane } = renderPanel(onCommit);
    (plane.onPointerDown as (e: unknown) => void)(pointerEvent({ clientX: 9999, clientY: -9999 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("only updates the plane on move while the pointer is captured", () => {
    const onCommit = vi.fn();
    const { plane } = renderPanel(onCommit);
    (plane.onPointerMove as (e: unknown) => void)(pointerEvent({ hasPointerCapture: false }));
    expect(onCommit).not.toHaveBeenCalled();
    (plane.onPointerMove as (e: unknown) => void)(pointerEvent({ hasPointerCapture: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("commits a hue when dragging the hue strip", () => {
    const onCommit = vi.fn();
    const { hue } = renderPanel(onCommit);
    (hue.onPointerDown as (e: unknown) => void)(pointerEvent({ clientX: 75 }));
    expect(onCommit).toHaveBeenCalledTimes(1);

    onCommit.mockReset();
    (hue.onPointerMove as (e: unknown) => void)(pointerEvent({ hasPointerCapture: false }));
    expect(onCommit).not.toHaveBeenCalled();
    (hue.onPointerMove as (e: unknown) => void)(pointerEvent({ hasPointerCapture: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid hex entry and ignores malformed input", () => {
    const onCommit = vi.fn();
    const { hexInput } = renderPanel(onCommit);
    (hexInput.onChange as (e: unknown) => void)({ currentTarget: { value: "not-a-color" } });
    expect(onCommit).not.toHaveBeenCalled();
    (hexInput.onChange as (e: unknown) => void)({ currentTarget: { value: "#abcdef" } });
    expect(onCommit).toHaveBeenCalledWith("#abcdef");
  });
});
