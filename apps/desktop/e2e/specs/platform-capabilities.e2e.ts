// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests save native screenshots.
import * as NodePath from "node:path";

import { ensureMainSidebarOpen, setDesktopUiWindowSize } from "../support/ui-state.ts";

const artifactDirectory = process.env.T4CODE_E2E_ARTIFACT_DIR;
if (!artifactDirectory) {
  throw new Error("T4CODE_E2E_ARTIFACT_DIR is required.");
}

describe("packaged preferences, native integrations, and platform capabilities", () => {
  it("exercises settings, updater-disabled state, provider shims, and openers", async () => {
    await ensureMainSidebarOpen();
    const settings = browser.$("button=Settings");
    await expect(settings).toBeDisplayed();
    await settings.click();
    const checkForUpdates = browser.$("button=Check for Updates");
    await checkForUpdates.scrollIntoView();
    await expect(checkForUpdates).toBeDisplayed();
    await expect(checkForUpdates).toBeDisabled();

    const themePreference = browser.$('[aria-label="Theme preference"]');
    await themePreference.scrollIntoView();
    await expect(themePreference).toBeDisplayed();
    await themePreference.click();
    const darkTheme = browser.$('//*[@role="option" and normalize-space()="Dark"]');
    await darkTheme.waitForDisplayed();
    await darkTheme.click();
    await expect(browser.$("html")).toHaveElementClass(expect.stringContaining("dark"));

    const providers = browser.$(
      "//button[@data-sidebar='menu-button'][.//span[normalize-space()='Providers']]",
    );
    await expect(providers).toBeDisplayed();
    await providers.click();
    await expect(browser.$("//*[normalize-space()='Codex']")).toBeDisplayed();
    const revealAccountEmail = browser.$('button[aria-label="Toggle account email visibility"]');
    await expect(revealAccountEmail).toBeDisplayed();
    await revealAccountEmail.click();
    await expect(browser.$("//*[contains(., 'fixture@example.test')]")).toBeDisplayed();

    const appOrigin = await browser.execute(() => window.location.origin);
    await browser.url(`${appOrigin}/#/settings/connections`);
    await expect(browser.$("//*[normalize-space()='Network access']")).toBeDisplayed();
    await expect(browser.$("//*[normalize-space()='Tailscale HTTPS']")).toBeDisplayed();
    const addEnvironment = browser.$('button[aria-label="Add environment"]');
    await expect(addEnvironment).toBeEnabled();
    await addEnvironment.click();
    await expect(browser.$("//*[normalize-space()='Add Environment']")).toBeDisplayed();
    await expect(browser.$("//*[normalize-space()='SSH']")).toBeDisplayed();
    await browser.keys("Escape");

    if (process.env.T4CODE_E2E_PLATFORM === "win") {
      const wslState = await browser.execute(async () => {
        const bridge = Reflect.get(window, "desktopBridge") as
          | {
              readonly getWslState?: () => Promise<{
                readonly available: boolean;
                readonly enabled: boolean;
                readonly wslOnly: boolean;
              }>;
            }
          | undefined;
        return (await bridge?.getWslState?.()) ?? null;
      });
      if (!wslState) {
        throw new Error("Expected the packaged Windows desktop bridge to report WSL state.");
      }

      const wslBackend = browser.$("//*[normalize-space()='WSL backend']");
      if (wslState.available || wslState.enabled || wslState.wslOnly) {
        await wslBackend.scrollIntoView();
        await expect(wslBackend).toBeDisplayed();
      } else {
        await expect(wslBackend).not.toExist();
      }
    }

    await browser.url(`${appOrigin}/#/settings/diagnostics`);
    const openLogsFolder = browser.$('button[aria-label="Open logs folder"]');
    await expect(openLogsFolder).toBeEnabled();
    await openLogsFolder.click();

    await setDesktopUiWindowSize(960, 640);
    await browser.saveScreenshot(
      NodePath.join(artifactDirectory, "platform-capabilities-minimum-size.png"),
    );
  });
});
