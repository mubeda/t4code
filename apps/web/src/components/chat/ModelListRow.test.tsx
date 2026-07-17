import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  buttonProps: [] as Array<Record<string, unknown>>,
  getDisplayName: vi.fn(() => "Display model"),
  getTriggerLabel: vi.fn(() => "Trigger model"),
}));

vi.mock("./providerIconUtils", () => ({
  getDisplayModelName: harness.getDisplayName,
  getTriggerDisplayModelLabel: harness.getTriggerLabel,
  PROVIDER_ICON_BY_PROVIDER: {
    codex: ({ className }: { className?: string }) => <span className={className}>provider</span>,
  },
}));
vi.mock("../ui/combobox", () => ({
  ComboboxItem: ({ children, ...props }: Record<string, unknown>) => (
    <div data-disabled={String(props.disabled)}>{children as React.ReactNode}</div>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttonProps.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("../ui/kbd", () => ({
  Kbd: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import { ModelListRow } from "./ModelListRow";

const model = { slug: "gpt-5", name: "GPT-5", subProvider: "OpenAI" } as never;

function renderRow(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <ModelListRow
      index={0}
      model={model}
      instanceId={"codex" as never}
      driverKind={"codex" as never}
      providerDisplayName="Codex Personal"
      isFavorite={false}
      isSelected={false}
      showProvider={false}
      onToggleFavorite={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  harness.buttonProps.length = 0;
  harness.getDisplayName.mockClear();
  harness.getTriggerLabel.mockClear();
});

describe("ModelListRow", () => {
  it("renders simple and fully decorated model rows", () => {
    expect(renderRow()).toContain("Display model");
    expect(harness.getDisplayName).toHaveBeenCalledWith(model, undefined);

    const decorated = renderRow({
      isFavorite: true,
      isSelected: true,
      showProvider: true,
      preferShortName: true,
      showNewBadge: true,
      jumpLabel: "⌘1",
    });
    expect(decorated).toContain("New");
    expect(decorated).toContain("Codex Personal · OpenAI");
    expect(decorated).toContain("provider");
    expect(decorated).toContain("⌘1");
    expect(decorated).toContain("Remove from favorites");
    expect(harness.getDisplayName).toHaveBeenLastCalledWith(model, { preferShortName: true });
  });

  it("uses trigger labels, handles unknown providers, and wraps disabled rows", () => {
    const markup = renderRow({
      useTriggerLabel: true,
      driverKind: "custom",
      showProvider: true,
      providerDisplayName: "Custom",
      disabledReason: "Unavailable on this account",
    });
    expect(markup).toContain("Trigger model");
    expect(markup).toContain("Unavailable on this account");
    expect(markup).toContain('data-disabled="true"');
    expect(markup).not.toContain("provider</span>");
  });

  it("stops favorite button events and toggles favorites", () => {
    const onToggleFavorite = vi.fn();
    renderRow({ onToggleFavorite });
    const button = harness.buttonProps[0]!;
    const clickEvent = { stopPropagation: vi.fn() };
    (button.onClick as (event: unknown) => void)(clickEvent);
    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(onToggleFavorite).toHaveBeenCalled();
    const keyEvent = { stopPropagation: vi.fn() };
    (button.onKeyDown as (event: unknown) => void)(keyEvent);
    expect(keyEvent.stopPropagation).toHaveBeenCalled();
    expect(button["aria-label"]).toBe("Add to favorites");
  });
});
