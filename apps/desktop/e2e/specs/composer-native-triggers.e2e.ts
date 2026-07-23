// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests read fixture logs and save screenshots.
import * as NodePath from "node:path";

import { readProviderInputLog } from "../support/provider-input-log.ts";
import { composerProviderProfiles, desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const artifactDirectory = process.env.T4CODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.T4CODE_E2E_PROJECT_PATH;
const providerInputLogPath = process.env.T4CODE_E2E_PROVIDER_INPUT_LOG;
if (!artifactDirectory || !projectPath || !providerInputLogPath) {
  throw new Error("The packaged desktop composer fixture environment was not prepared.");
}

const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const preparedProviderInputLogPath: string = providerInputLogPath;

type ComposerProvider = keyof typeof composerProviderProfiles;

interface ProviderScenario {
  readonly provider: ComposerProvider;
  readonly displayName: string;
  readonly keyboardCommand: string;
  readonly nativePrompt: string;
}

const visibleComposerFormSelector =
  '//*[@data-chat-composer-form="true" and not(ancestor::*[contains(concat(" ", normalize-space(@class), " "), " hidden ")])]';

const scenarios: readonly ProviderScenario[] = [
  {
    provider: "codex",
    displayName: "Codex",
    keyboardCommand: "goal",
    nativePrompt: "$refactor",
  },
  {
    provider: "claudeAgent",
    displayName: "Claude",
    keyboardCommand: "compact",
    nativePrompt: "/compact",
  },
  {
    provider: "cursor",
    displayName: "Cursor",
    keyboardCommand: "review",
    nativePrompt: "/review",
  },
  {
    provider: "opencode",
    displayName: "OpenCode",
    keyboardCommand: "init",
    nativePrompt: "@reviewer",
  },
  {
    provider: "grok",
    displayName: "Grok",
    keyboardCommand: "skills",
    nativePrompt: "/skills",
  },
] as const;

function composerForm() {
  return browser.$(visibleComposerFormSelector);
}

function composerEditor() {
  return composerForm().$('[data-testid="composer-editor"]');
}

async function visibleComposerItemIds(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-composer-item-id]")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0
        );
      })
      .map((element) => element.dataset.composerItemId ?? "")
      .filter((id) => id.length > 0),
  );
}

async function waitForComposerItem(id: string): Promise<void> {
  await browser.waitUntil(async () => (await visibleComposerItemIds()).includes(id), {
    timeoutMsg: `Composer item did not appear: ${id}`,
  });
}

async function waitForComposerItemsToClose(): Promise<void> {
  await browser.waitUntil(async () => (await visibleComposerItemIds()).length === 0, {
    timeoutMsg: "The stale composer menu remained open.",
  });
}

async function setComposerValue(value: string): Promise<void> {
  const editor = composerEditor();
  await expect(editor).toBeDisplayed();
  await editor.setValue(value);
}

async function waitForComposerValue(value: string): Promise<void> {
  await browser.waitUntil(async () => (await composerEditor().getText()) === value, {
    timeoutMsg: `Composer did not contain ${JSON.stringify(value)}.`,
  });
}

async function ensureFixtureProjectImported(): Promise<void> {
  await ensureMainSidebarOpen();
  const existingProject = browser.$(
    `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
  );
  if (await existingProject.isExisting()) return;

  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await expect(addProject).toBeDisplayed();
  await addProject.click();
  await browser.$('[role="dialog"]').waitForExist();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(preparedProjectPath);
  await browseFolder.click();
  await existingProject.waitForDisplayed();
}

async function openInitialCodexDraft(): Promise<void> {
  const project = browser.$(
    `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
  );
  await expect(project).toBeDisplayed();
  await project.click();
  await project.moveTo();
  const newChat = browser.$(
    '[data-testid="new-main-chat-button"], [data-testid="sidebar-new-main-chat-trigger"]',
  );
  await expect(newChat).toBeEnabled();
  await newChat.click();
  await expect(composerEditor()).toBeDisplayed();
}

async function openProviderPanel(displayName: string): Promise<void> {
  const newPanel = browser.$(
    '//*[@aria-label="New panel" and not(ancestor::*[contains(concat(" ", normalize-space(@class), " "), " hidden ")])]',
  );
  await browser.waitUntil(
    async () =>
      (await newPanel.isExisting()) &&
      (await newPanel.isDisplayed()) &&
      (await newPanel.isEnabled()),
    {
      timeoutMsg: "The provider panel menu did not become available.",
    },
  );
  await newPanel.click();
  const provider = browser.$(`//*[@role="menuitem"][.//span[normalize-space()="${displayName}"]]`);
  await provider.waitForDisplayed();
  await provider.click();
  await expect(composerEditor()).toBeDisplayed();
}

async function assertColonMenu(provider: ComposerProvider): Promise<void> {
  await setComposerValue(":");
  await waitForComposerItem("t4code-action:default");
  const ids = await visibleComposerItemIds();
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every((id) => id.startsWith("t4code-action:"))).toBe(true);
  if (provider === "codex") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-colon-menu.png"),
    );
  }
  await browser.$('[data-composer-item-id="t4code-action:default"]').click();
  await waitForComposerValue("");
}

async function assertSlashMenu(scenario: ProviderScenario): Promise<void> {
  const profile = composerProviderProfiles[scenario.provider];
  await setComposerValue("/");
  await waitForComposerItem(`provider-command:${scenario.provider}:${scenario.keyboardCommand}`);
  const ids = await visibleComposerItemIds();
  for (const command of profile.commands) {
    expect(ids).toContain(`provider-command:${scenario.provider}:${command}`);
  }
  for (const skill of profile.slashSkills) {
    expect(ids).toContain(`provider-skill:${scenario.provider}:slash:${skill}`);
  }
  expect(ids.some((id) => id.startsWith("t4code-action:"))).toBe(false);
  expect(ids.some((id) => id.startsWith("agent-reference:"))).toBe(false);
  expect(ids.some((id) => id.startsWith("file-reference:"))).toBe(false);
  if (scenario.provider === "claudeAgent") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-slash-groups.png"),
    );
  }

  await setComposerValue(`/${scenario.keyboardCommand}`);
  await waitForComposerItem(`provider-command:${scenario.provider}:${scenario.keyboardCommand}`);
  await composerEditor().click();
  await browser.keys(["ArrowDown", "Enter"]);
  await waitForComposerValue(`/${scenario.keyboardCommand} `);
  await setComposerValue("");
}

async function assertDollarMenu(provider: ComposerProvider): Promise<void> {
  const profile = composerProviderProfiles[provider];
  await setComposerValue("$");
  if (profile.dollarSkills.length === 0) {
    await waitForComposerItemsToClose();
    return;
  }
  for (const skill of profile.dollarSkills) {
    await waitForComposerItem(`provider-skill:${provider}:dollar:${skill}`);
  }
  const ids = await visibleComposerItemIds();
  expect(ids.every((id) => id.startsWith(`provider-skill:${provider}:dollar:`))).toBe(true);
  await setComposerValue("");
}

async function assertReferenceMenu(provider: ComposerProvider): Promise<void> {
  const expectedAgents = composerProviderProfiles[provider].mentionableAgents;
  await setComposerValue("@");
  await waitForComposerItem("file-reference:file:README.md");
  const ids = await visibleComposerItemIds();
  expect(ids.some((id) => id.startsWith("file-reference:"))).toBe(true);
  const agentIds = ids.filter((id) => id.startsWith("agent-reference:")).toSorted();
  expect(agentIds).toEqual(
    expectedAgents.map((agent) => `agent-reference:${provider}:${agent}`).toSorted(),
  );
  if (provider === "opencode") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-reference-groups.png"),
    );
  }

  await setComposerValue("@README");
  await waitForComposerItem("file-reference:file:README.md");
  await browser.$('[data-composer-item-id="file-reference:file:README.md"]').click();
  await expect(composerForm().$('[data-composer-mention-chip="true"]')).toBeDisplayed();
  await setComposerValue("");
}

async function sendAndAssertNativePrompt(scenario: ProviderScenario): Promise<void> {
  await setComposerValue(scenario.nativePrompt);
  const send = composerForm().$('button[aria-label="Send message"]');
  await expect(send).toBeEnabled();
  await send.click();
  await browser.waitUntil(
    () =>
      readProviderInputLog(preparedProviderInputLogPath).some(
        (entry) => entry.provider === scenario.provider && entry.prompt === scenario.nativePrompt,
      ),
    {
      timeoutMsg: `${scenario.displayName} did not record ${scenario.nativePrompt}.`,
    },
  );
}

async function leaveMenuOpenAndSwitchProvider(
  current: ProviderScenario,
  next: ProviderScenario,
): Promise<void> {
  await setComposerValue("/");
  await waitForComposerItem(`provider-command:${current.provider}:${current.keyboardCommand}`);
  await openProviderPanel(next.displayName);
  await browser.waitUntil(
    async () =>
      !(await visibleComposerItemIds()).some((id) => id.includes(`:${current.provider}:`)),
    {
      timeoutMsg: `The ${current.displayName} composer menu survived the provider switch.`,
    },
  );
}

async function persistDraftAndRestart(
  provider: "codex" | "opencode",
  displayName: string,
): Promise<void> {
  await openProviderPanel(displayName);
  await setComposerValue("@README.md @reviewer $refactor");
  await browser.reloadSession();
  await expect(composerEditor()).toBeDisplayed();
  const mentionChip = composerForm().$('[data-composer-mention-chip="true"]');
  await expect(mentionChip).toBeDisplayed();
  await expect(mentionChip).toHaveText("README.md");
  const skillChip = composerForm().$('[data-composer-skill-chip="true"]');
  await expect(skillChip).toBeDisplayed();
  await expect(skillChip).toHaveText("Refactor");
  if (provider === "opencode") {
    const agentChip = composerForm().$('[data-composer-agent-chip="true"]');
    await expect(agentChip).toBeDisplayed();
    await expect(agentChip).toHaveText("reviewer");
  }
}

describe("packaged native composer triggers", () => {
  it("normalizes every provider, sends exact native syntax, closes stale menus, and restores chips", async () => {
    await setDesktopUiWindowSize(1_100, 760);
    await ensureFixtureProjectImported();
    await openInitialCodexDraft();

    for (const [index, scenario] of scenarios.entries()) {
      await assertColonMenu(scenario.provider);
      await assertSlashMenu(scenario);
      await assertDollarMenu(scenario.provider);
      await assertReferenceMenu(scenario.provider);
      await sendAndAssertNativePrompt(scenario);

      const next = scenarios[index + 1];
      if (next) {
        await leaveMenuOpenAndSwitchProvider(scenario, next);
      }
    }

    await setComposerValue("/");
    await waitForComposerItem("provider-command:grok:skills");
    await persistDraftAndRestart("codex", "Codex");
    await persistDraftAndRestart("opencode", "OpenCode");
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-restored-chips.png"),
    );
  });
});
