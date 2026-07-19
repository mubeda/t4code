// @effect-diagnostics nodeBuiltinImport:off - WDIO configuration manages host test artifacts.
// @effect-diagnostics globalConsole:off - WDIO configuration reports the retained artifact path.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveDesktopAppPath, type DesktopUiPlatform } from "./support/app-path.ts";
import {
  deferDesktopUiTestContextCleanupUntilExit,
  prepareDesktopUiTestContext,
} from "./support/test-project.ts";
import { normalizeWebDriverRequest } from "./support/webdriver-request.ts";

// oxlint-disable-next-line t4code/no-global-process-runtime -- The standalone WDIO config detects the host once and passes it to pure adapters.
const hostPlatform = process.platform;
const platform: DesktopUiPlatform =
  process.env.T4CODE_E2E_PLATFORM === "mac" ||
  process.env.T4CODE_E2E_PLATFORM === "linux" ||
  process.env.T4CODE_E2E_PLATFORM === "win"
    ? process.env.T4CODE_E2E_PLATFORM
    : hostPlatform === "darwin"
      ? "mac"
      : hostPlatform === "win32"
        ? "win"
        : "linux";
const testContext = prepareDesktopUiTestContext();
const appBinaryPath = resolveDesktopAppPath({
  platform,
  environment: process.env,
});
const requestedSpec = process.env.T4CODE_E2E_SPEC?.trim();

if (!NodeFS.existsSync(appBinaryPath)) {
  throw new Error(`Packaged T4Code application does not exist: ${appBinaryPath}`);
}

const screenshotPath = (title: string): string =>
  NodePath.join(
    testContext.artifactDirectory,
    `${title
      .replaceAll(/[^a-z0-9]+/gi, "-")
      .replaceAll(/(^-|-$)/g, "")
      .toLowerCase()}.png`,
  );

export const config = {
  runner: "local",
  specs:
    requestedSpec && requestedSpec.length > 0
      ? [requestedSpec]
      : [
          "./specs/main-window.e2e.ts",
          "./specs/project-session-terminal.e2e.ts",
          "./specs/platform-capabilities.e2e.ts",
          "./specs/terminal-font.e2e.ts",
        ],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider: "embedded",
        embeddedPort: Number(process.env.T4CODE_E2E_WEBDRIVER_PORT ?? 4_445),
        startTimeout: 90_000,
        statusPollTimeout: 10_000,
        commandTimeout: 30_000,
        logDir: testContext.artifactDirectory,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinaryPath,
      },
    },
  ],
  logLevel: "info",
  outputDir: testContext.artifactDirectory,
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  transformRequest: normalizeWebDriverRequest,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  before: async () => {
    await browser.execute(() => {
      const sheet = [...document.styleSheets].find((candidate) => {
        try {
          void candidate.cssRules;
          return true;
        } catch {
          return false;
        }
      });
      if (sheet === undefined) {
        throw new Error("No writable bundled stylesheet is available for desktop UI automation.");
      }
      const rules = [
        `
        *, *::before, *::after {
          animation-delay: 0s !important;
          animation-duration: 0s !important;
          transition-delay: 0s !important;
          transition-duration: 0s !important;
        }`,
        `
        [data-open][data-starting-style] {
          opacity: 1 !important;
          scale: 1 !important;
          translate: none !important;
          transform: none !important;
        }`,
        `
        [data-closed] {
          display: none !important;
        }`,
        `
        [data-slot="sidebar-group"]:has([data-testid="sidebar-new-main-chat-trigger"])
          ul[data-sidebar="menu"] > li {
          opacity: 1 !important;
          transform: none !important;
        }`,
      ];
      for (const rule of rules) {
        sheet.insertRule(rule, sheet.cssRules.length);
      }
      document.documentElement.dataset.t4codeDesktopUiMotion = "disabled";
    });
  },
  afterTest: async (
    test: { readonly title: string },
    _context: unknown,
    result: { readonly passed: boolean },
  ) => {
    if (!result.passed) {
      await browser.saveScreenshot(screenshotPath(`failure-${test.title}`));
      NodeFS.writeFileSync(
        screenshotPath(`failure-source-${test.title}`).replace(/\.png$/, ".html"),
        await browser.getPageSource(),
      );
    }
  },
  onComplete: () => {
    // WDIO invokes configuration hooks before launcher service hooks. Defer shared fixture cleanup
    // until process exit so the Tauri service has released Windows filesystem handles first.
    // oxlint-disable-next-line t4code/no-global-process-runtime -- The standalone launcher owns this process lifecycle.
    deferDesktopUiTestContextCleanupUntilExit(testContext, process);
    console.log(`Desktop UI artifacts: ${testContext.artifactDirectory}`);
  },
};
