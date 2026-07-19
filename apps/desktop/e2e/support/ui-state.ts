import { scaleDesktopUiWindowSize } from "./window-size.ts";

export async function mockDesktopUiFolderPicker(projectPath: string): Promise<void> {
  const picker = await browser.tauri.mock("desktop_bridge_pick_folder");
  await picker.mockReturnValue(projectPath);
}

export async function setDesktopUiWindowSize(width: number, height: number): Promise<void> {
  const devicePixelRatio = await browser.execute(() => window.devicePixelRatio);
  const physicalSize = scaleDesktopUiWindowSize({ width, height }, devicePixelRatio);
  await browser.setWindowSize(physicalSize.width, physicalSize.height);
}

export async function ensureMainSidebarOpen(): Promise<void> {
  await setDesktopUiWindowSize(1_000, 720);
  const wrapper = browser.$('[data-slot="sidebar-wrapper"]');
  await expect(wrapper).toBeDisplayed();

  if ((await wrapper.getAttribute("data-sidebar-state")) === "collapsed") {
    const toggle = browser.$('button[aria-label="Toggle main sidebar"]');
    await expect(toggle).toBeDisplayed();
    await toggle.click();
  }

  await expect(wrapper).toHaveAttribute("data-sidebar-state", "expanded");
}

export async function getMainSidebarVisibilityDiagnostics(): Promise<unknown> {
  return browser.execute(() => {
    const trigger = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-add-project-trigger"]',
    );
    const ancestry: Array<Record<string, unknown>> = [];
    let current: HTMLElement | null = trigger;
    while (current && ancestry.length < 8) {
      const style = window.getComputedStyle(current);
      const rect = current.getBoundingClientRect();
      ancestry.push({
        tag: current.tagName,
        dataSlot: current.dataset.slot ?? null,
        dataState: current.dataset.state ?? null,
        className: current.className,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        position: style.position,
        transform: style.transform,
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
      });
      current = current.parentElement;
    }
    return {
      innerWidth: window.innerWidth,
      outerWidth: window.outerWidth,
      devicePixelRatio: window.devicePixelRatio,
      desktopMediaQuery: window.matchMedia("(min-width: 48rem)").matches,
      ancestry,
    };
  });
}

export async function getAddProjectDialogVisibilityDiagnostics(): Promise<unknown> {
  return browser.execute(() => {
    const describe = (element: HTMLElement | null): Record<string, unknown> | null => {
      if (!element) return null;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        dataStartingStyle: element.hasAttribute("data-starting-style"),
        dataOpen: element.hasAttribute("data-open"),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        position: style.position,
        transform: style.transform,
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
      };
    };
    const browse = [...document.querySelectorAll<HTMLElement>("[data-add-project-action]")].find(
      (element) => element.textContent?.includes("Browse folder"),
    );
    const popup = document.querySelector<HTMLElement>('[role="dialog"]');
    const motionRules = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules]
          .map((rule) => rule.cssText)
          .filter(
            (rule) =>
              rule.includes("[data-open][data-starting-style]") || rule.includes("[data-closed]"),
          );
      } catch {
        return [];
      }
    });
    return {
      popup: describe(popup),
      viewport: describe(document.querySelector<HTMLElement>('[data-slot="dialog-viewport"]')),
      browse: describe(browse ?? null),
      popupMatchesOpenStarting: popup?.matches("[data-open][data-starting-style]") ?? false,
      motionStyleInstalled: document.documentElement.dataset.t4codeDesktopUiMotion === "disabled",
      motionSheetActive: motionRules.length === 2,
      motionRules,
    };
  });
}
