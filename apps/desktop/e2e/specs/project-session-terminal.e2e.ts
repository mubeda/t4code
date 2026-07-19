// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests save native screenshots.
import * as NodePath from "node:path";

import { desktopUiFixture } from "../support/test-project.ts";
import { terminalOutputEventCount } from "../support/terminal-events.ts";
import { ensureMainSidebarOpen, setDesktopUiWindowSize } from "../support/ui-state.ts";

const artifactDirectory = process.env.T4CODE_E2E_ARTIFACT_DIR;
if (!artifactDirectory) {
  throw new Error("T4CODE_E2E_ARTIFACT_DIR is required.");
}
const stateRoot = process.env.T4CODE_HOME;
if (!stateRoot) {
  throw new Error("T4CODE_HOME is required.");
}

describe("packaged project session and terminal", () => {
  it("streams a fixture response, reconnects, and exercises terminal lifecycle", async () => {
    await ensureMainSidebarOpen();
    const project = browser.$(
      `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
    );
    await expect(project).toBeDisplayed();
    await project.click();

    const newChat = browser.$('[data-testid="sidebar-new-main-chat-trigger"]');
    await expect(newChat).toBeEnabled();
    await newChat.click();

    const providerModelPicker = browser.$('[data-chat-provider-model-picker="true"]');
    await expect(providerModelPicker).toBeEnabled();
    await expect(providerModelPicker).toHaveText(expect.stringContaining("GPT-5.4"));

    const composer = browser.$('[data-testid="composer-editor"]');
    await expect(composer).toBeDisplayed();
    await composer.setValue("render the deterministic fixture response");
    const send = browser.$('button[aria-label="Send message"]');
    await expect(send).toBeEnabled();
    await send.click();

    const streamedResponse = browser.$(
      `//*[contains(normalize-space(), "${desktopUiFixture.streamedResponse}")]`,
    );
    await expect(streamedResponse).toBeDisplayed();

    const terminalToggle = browser.$('button[aria-label="Toggle terminal drawer"]');
    await expect(terminalToggle).toBeEnabled();
    await terminalToggle.click();
    const terminalScreen = browser.$(".xterm-screen");
    await expect(terminalScreen).toBeDisplayed();
    await terminalScreen.click();
    expect(
      await browser.execute(() => {
        const element = document.querySelector<HTMLElement>(".xterm-helper-textarea");
        element?.focus();
        return document.activeElement === element;
      }),
    ).toBe(true);
    const outputEventsBeforeInput = terminalOutputEventCount(stateRoot);
    await browser.keys(["echo T4CODE_TERMINAL_SMOKE", "Enter"]);
    await browser.waitUntil(() => terminalOutputEventCount(stateRoot) > outputEventsBeforeInput, {
      timeoutMsg: "The terminal did not produce output after WebDriver keyboard input.",
    });

    await setDesktopUiWindowSize(960, 640);
    await browser.saveScreenshot(
      NodePath.join(artifactDirectory, "project-session-terminal-minimum-size.png"),
    );
    const closeTerminal = browser.$('button[aria-label="Close Terminal"]');
    await expect(closeTerminal).toBeDisplayed();
    await closeTerminal.click();

    await browser.refresh();
    await expect(
      browser.$(`//*[contains(normalize-space(), "${desktopUiFixture.streamedResponse}")]`),
    ).toBeDisplayed();
  });
});
