// @vitest-environment happy-dom

import { ProviderInstanceId, type ServerProvider } from "@t4code/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";

vi.mock("lucide-react", () => ({
  SparklesIcon: () => <span data-icon="sparkles" />,
  StarIcon: () => <span data-icon="star" />,
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children?: ReactNode }) => <span data-tooltip>{children}</span>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<Record<string, unknown>>;
    children?: ReactNode;
  }) => (children === undefined ? cloneElement(render) : cloneElement(render, {}, children)),
}));

vi.mock("~/lib/utils", () => ({
  cn: (...values: ReadonlyArray<unknown>) => values.filter(Boolean).join(" "),
}));

vi.mock("./ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: (props: {
    displayName: string;
    showBadge: boolean;
    indicatorBackground: string;
    badgeClassName?: string;
  }) => (
    <span
      data-provider-icon={props.displayName}
      data-show-badge={String(props.showBadge)}
      data-indicator-background={props.indicatorBackground}
      data-badge-class={props.badgeClassName ?? ""}
    />
  ),
}));

import { ModelPickerSidebar } from "./ModelPickerSidebar";

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
const onSelectInstance = vi.fn();

function entry(
  instanceId: string,
  overrides: Partial<ProviderInstanceEntry> = {},
): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: "codex" as ProviderInstanceEntry["driverKind"],
    displayName: instanceId,
    accentColor: undefined,
    continuationGroupKey: undefined,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: { message: null } as unknown as ServerProvider,
    models: [],
    ...overrides,
  };
}

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof ModelPickerSidebar>> = {},
): ReactElement {
  return (
    <ModelPickerSidebar
      selectedInstanceId="favorites"
      onSelectInstance={onSelectInstance}
      instanceEntries={[]}
      {...overrides}
    />
  );
}

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  await act(async () => root.render(element));
  return mounted;
}

async function dispatch(element: HTMLElement, event: Event): Promise<void> {
  await act(async () => element.dispatchEvent(event));
}

function providerButton(container: HTMLElement, id: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`[data-model-picker-provider="${id}"]`);
  if (result === null) throw new Error(`Missing provider button ${id}.`);
  return result;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onSelectInstance.mockReset();
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ModelPickerSidebar", () => {
  it("shows and selects favorites by default", async () => {
    const mounted = await mount(renderSidebar());
    const favorites = providerButton(mounted.container, "favorites");

    await dispatch(favorites, new MouseEvent("click", { bubbles: true }));

    expect(onSelectInstance).toHaveBeenCalledWith("favorites");
    expect(mounted.container.textContent).toContain("Favorites");
  });

  it("can hide favorites for a locked provider picker", async () => {
    const mounted = await mount(
      renderSidebar({ showFavorites: false, instanceEntries: [entry("codex")] }),
    );

    expect(mounted.container.querySelector('[data-model-picker-provider="favorites"]')).toBeNull();
    expect(providerButton(mounted.container, "codex")).toBeDefined();
  });

  it("selects ready instances and ignores unavailable instances", async () => {
    const ready = entry("ready", { displayName: "Ready Provider" });
    const unavailable = entry("offline", {
      displayName: "Offline Provider",
      isAvailable: false,
      status: "error",
      snapshot: { message: "Binary not found" } as unknown as ServerProvider,
    });
    const mounted = await mount(renderSidebar({ instanceEntries: [ready, unavailable] }));
    const readyButton = providerButton(mounted.container, "ready");
    const unavailableButton = providerButton(mounted.container, "offline");

    await dispatch(readyButton, new MouseEvent("click", { bubbles: true }));
    await dispatch(unavailableButton, new MouseEvent("click", { bubbles: true }));

    expect(onSelectInstance).toHaveBeenCalledOnce();
    expect(onSelectInstance).toHaveBeenCalledWith(ProviderInstanceId.make("ready"));
    expect(unavailableButton.disabled).toBe(true);
    expect(unavailableButton.getAttribute("aria-label")).toBe(
      "Offline Provider — Unavailable. Binary not found",
    );
  });

  it.each([
    [
      entry("disabled", { displayName: "Disabled", enabled: false }),
      "Disabled — Disabled in settings.",
    ],
    [
      entry("disabled-status", { displayName: "Disabled Status", status: "disabled" }),
      "Disabled Status — Disabled in settings.",
    ],
    [
      entry("warning", {
        displayName: "Warning",
        status: "warning",
        snapshot: { message: "  " } as unknown as ServerProvider,
      }),
      "Warning — Limited.",
    ],
    [entry("starting", { displayName: "Starting", isAvailable: false }), "Starting — Not ready."],
  ] as const)("describes unavailable instance states", async (instance, expected) => {
    const mounted = await mount(renderSidebar({ instanceEntries: [instance] }));

    expect(providerButton(mounted.container, instance.instanceId).getAttribute("aria-label")).toBe(
      expected,
    );
    expect(mounted.container.textContent).toContain(expected);
  });

  it("uses context-disabled copy and marks new instances", async () => {
    const blocked = entry("blocked", { displayName: "Blocked" });
    const fresh = entry("fresh", { displayName: "Fresh" });
    const mounted = await mount(
      renderSidebar({
        instanceEntries: [blocked, fresh],
        disabledInstanceIds: new Set([blocked.instanceId]),
        getDisabledInstanceTooltip: () => "Unavailable for this thread",
        newBadgeInstanceIds: new Set([fresh.instanceId]),
      }),
    );

    expect(providerButton(mounted.container, "blocked").getAttribute("aria-label")).toBe(
      "Unavailable for this thread",
    );
    expect(providerButton(mounted.container, "fresh").getAttribute("aria-label")).toBe(
      "Fresh, new",
    );
    expect(mounted.container.querySelectorAll("[data-icon=sparkles]")).toHaveLength(1);
  });

  it("shows instance badges for accent colors and duplicate drivers", async () => {
    const custom = entry("custom", { displayName: "Custom", accentColor: "#ff00aa" });
    const duplicate = entry("duplicate", { displayName: "Duplicate" });
    const mounted = await mount(renderSidebar({ instanceEntries: [custom, duplicate] }));

    expect(mounted.container.querySelector('[data-provider-icon="Custom"]')).toMatchObject({
      dataset: { showBadge: "true" },
    });
    expect(mounted.container.querySelector('[data-provider-icon="Duplicate"]')).toMatchObject({
      dataset: { showBadge: "true" },
    });
    expect(mounted.container.querySelector('[data-provider-icon="Custom"]')).toMatchObject({
      dataset: { badgeClass: expect.stringContaining("text-[7px]") },
    });
  });

  it("updates icon hover state on focus and blur", async () => {
    const mounted = await mount(
      renderSidebar({
        selectedInstanceId: ProviderInstanceId.make("other"),
        instanceEntries: [entry("codex", { displayName: "Codex" })],
      }),
    );
    const target = providerButton(mounted.container, "codex");

    await act(async () => target.focus());
    expect(
      mounted.container
        .querySelector('[data-provider-icon="Codex"]')
        ?.getAttribute("data-indicator-background"),
    ).toBe("var(--muted)");

    await act(async () => target.blur());
    expect(
      mounted.container
        .querySelector('[data-provider-icon="Codex"]')
        ?.getAttribute("data-indicator-background"),
    ).toContain("color-mix");
  });

  it("positions the selected indicator from the selected button geometry", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const isProvider = this.hasAttribute("data-model-picker-provider");
        return {
          x: 0,
          y: isProvider ? 40 : 10,
          top: isProvider ? 40 : 10,
          right: 0,
          bottom: 0,
          left: 0,
          width: 24,
          height: isProvider ? 20 : 100,
          toJSON: () => ({}),
        };
      },
    );
    const mounted = await mount(
      renderSidebar({
        selectedInstanceId: ProviderInstanceId.make("codex"),
        instanceEntries: [entry("codex")],
      }),
    );

    expect(
      mounted.container.querySelector<HTMLElement>("[data-model-picker-selected-indicator]")?.style
        .top,
    ).toBe("30px");
  });
});
