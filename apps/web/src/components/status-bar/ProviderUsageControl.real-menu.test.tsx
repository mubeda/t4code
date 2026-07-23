// @vitest-environment happy-dom

import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProviderUsageControl } from "./ProviderUsageControl";
import type { ProviderUsageViewModel, UsageWindowViewModel } from "./providerUsagePresentation";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
const updatedAt = DateTime.makeUnsafe("2026-07-22T20:00:00.000Z");

function usageWindow(): UsageWindowViewModel {
  return {
    key: "session",
    label: "Session",
    windowLabel: "5h",
    consumedPercent: 40,
    displayedPercent: 60,
    fillPercent: 60,
    percentageLabel: "60% remaining",
    resetLabel: "Resets in 5m",
    resetsAt: null,
    resetDescription: null,
    barColorClass: "bg-emerald-500",
  };
}

function provider(kind: ProviderUsageViewModel["provider"]): ProviderUsageViewModel {
  const session = usageWindow();
  return {
    provider: kind,
    status: "ok",
    windows: [session],
    detailedWindows: [session],
    compactWindows: [session],
    plan: null,
    credits:
      kind === "codex"
        ? {
            availableCount: 1,
            totalEarnedCount: 1,
            nextExpiresAt: null,
            nextExpiresLabel: null,
          }
        : null,
    updatedAt,
    error: null,
  };
}

async function flushMenu(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pressKey(target: Element, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
  await flushMenu();
}

async function pressTab(from: HTMLElement, to: HTMLElement, shiftKey = false): Promise<void> {
  await act(async () => {
    const keydown = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    from.dispatchEvent(keydown);
    if (!keydown.defaultPrevented && to.isConnected) {
      to.focus();
    }
    from.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flushMenu();
}

function detailButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`${label} button was not rendered.`);
  return button;
}

async function activateNativeButtonByKeyboard(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    const keydown = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(keydown);
    target.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }),
    );
    if (!keydown.defaultPrevented) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    }
  });
  await flushMenu();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ProviderUsageControl with Base UI Popover", () => {
  it("tabs through provider actions and restores focus to each trigger on Escape", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(
        <>
          <ProviderUsageControl
            iconOnly={false}
            statusBarUsageMode="detailed"
            viewModel={provider("claude")}
            onOpenProviderSettings={vi.fn()}
          />
          <ProviderUsageControl
            iconOnly={false}
            statusBarUsageMode="detailed"
            viewModel={provider("codex")}
            onConsumeCodexRateLimitReset={vi.fn(async () => {
              throw new Error("Reset command is not exercised by this focus test.");
            })}
            onOpenProviderSettings={vi.fn()}
          />
        </>,
      );
    });

    const claudeTrigger = container.querySelector<HTMLButtonElement>('[aria-label="Claude usage"]');
    const codexTrigger = container.querySelector<HTMLButtonElement>('[aria-label="Codex usage"]');
    if (claudeTrigger === null || codexTrigger === null) {
      throw new Error("Independent provider triggers were not rendered.");
    }

    claudeTrigger.focus();
    await activateNativeButtonByKeyboard(claudeTrigger);
    expect(document.querySelector('[data-testid="provider-usage-detail"]')?.textContent).toContain(
      "Claude",
    );
    expect(document.querySelector('[data-testid="provider-usage-roster"]')).toBeNull();
    expect(document.querySelector('[aria-label="Back to provider usage"]')).toBeNull();

    const claudePopup = document.querySelector<HTMLElement>(
      '[data-testid="provider-usage-detail"]',
    );
    if (claudePopup === null) throw new Error("Claude detail was not rendered.");
    const claudeSettings = detailButton("Provider settings");
    await pressTab(claudeTrigger, claudeSettings);
    expect(document.activeElement).toBe(claudeSettings);
    expect(document.querySelector('[data-testid="provider-usage-detail"]')).not.toBeNull();
    await pressKey(claudeSettings, "Escape");
    expect(document.querySelector('[data-testid="provider-usage-detail"]')).toBeNull();
    expect(document.activeElement).toBe(claudeTrigger);

    codexTrigger.focus();
    await activateNativeButtonByKeyboard(codexTrigger);
    expect(document.querySelector('[data-testid="provider-usage-detail"]')?.textContent).toContain(
      "Codex",
    );
    const codexPopup = document.querySelector<HTMLElement>('[data-testid="provider-usage-detail"]');
    if (codexPopup === null) throw new Error("Codex detail was not rendered.");
    const resetNow = detailButton("Reset now");
    const codexSettings = detailButton("Provider settings");
    await pressTab(codexTrigger, resetNow);
    expect(document.activeElement).toBe(resetNow);
    await pressTab(resetNow, codexSettings);
    expect(document.activeElement).toBe(codexSettings);
    await pressTab(codexSettings, resetNow, true);
    expect(document.activeElement).toBe(resetNow);
    expect(document.querySelector('[data-testid="provider-usage-detail"]')).not.toBeNull();
    await pressKey(resetNow, "Escape");
    expect(document.querySelector('[data-testid="provider-usage-detail"]')).toBeNull();
    expect(document.activeElement).toBe(codexTrigger);
  });
});
