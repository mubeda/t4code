// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests read fixture logs and save screenshots.
import * as NodePath from "node:path";

import {
  readProviderInputLog,
  waitForProviderInputLogEntry,
} from "../support/provider-input-log.ts";
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

const composerGroupLabels = {
  t4code: "T4Code",
  commands: "Commands",
  skills: "Skills",
  files: "Files",
  agents: "Agents",
} as const;

type ComposerGroupId = keyof typeof composerGroupLabels;

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

const expectedProviderInputs = [
  { provider: "codex", prompt: "$refactor" },
  { provider: "codex", prompt: "@README.md" },
  { provider: "claudeAgent", prompt: "/compact" },
  { provider: "claudeAgent", prompt: "/docs" },
  { provider: "cursor", prompt: "/review" },
  { provider: "opencode", prompt: "@reviewer" },
  { provider: "grok", prompt: "/skills" },
] as const;

function composerForm() {
  return browser.$(visibleComposerFormSelector);
}

function composerEditor() {
  return composerForm().$('[data-testid="composer-editor"]');
}

async function waitForComposerDisplayed(): Promise<void> {
  const form = browser.$(visibleComposerFormSelector);
  await form.waitForExist();
  await form.waitForDisplayed();
  await form.$('[data-testid="composer-editor"]').waitForDisplayed();
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

async function visibleComposerGroups(): Promise<Array<{ id: string; label: string }>> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-composer-group]")]
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
      .map((element) => {
        const id = element.dataset.composerGroup ?? "";
        const label =
          element.querySelector<HTMLElement>(`[data-composer-group-label="${CSS.escape(id)}"]`)
            ?.textContent ?? "";
        return { id, label };
      }),
  );
}

async function assertComposerGroups(expectedIds: readonly ComposerGroupId[]): Promise<void> {
  const expected = expectedIds.map((id) => ({ id, label: composerGroupLabels[id] }));
  await browser.waitUntil(
    async () => JSON.stringify(await visibleComposerGroups()) === JSON.stringify(expected),
    {
      timeoutMsg: `Composer groups did not match ${JSON.stringify(expected)}.`,
    },
  );
  expect(await visibleComposerGroups()).toEqual(expected);
}

async function waitForComposerItem(id: string): Promise<void> {
  await browser.waitUntil(async () => (await visibleComposerItemIds()).includes(id), {
    timeoutMsg: `Composer item did not appear: ${id}`,
  });
}

async function clickVisibleComposerItem(id: string): Promise<void> {
  const selector = `[data-composer-item-id="${id}"]`;
  await waitForComposerItem(id);
  for (const candidate of await browser.$$(selector)) {
    if ((await candidate.isDisplayed()) && (await candidate.isEnabled())) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`The visible composer item was not clickable: ${id}`);
}

async function waitForComposerItemsToClose(): Promise<void> {
  await browser.waitUntil(async () => (await visibleComposerItemIds()).length === 0, {
    timeoutMsg: "The stale composer menu remained open.",
  });
}

async function appendAndSelectComposerItem(input: string, itemId: string): Promise<void> {
  const editor = composerEditor();
  await editor.click();
  await editor.addValue(input);
  await waitForComposerItem(itemId);
  await clickVisibleComposerItem(itemId);
}

async function visibleComposerChipTexts(
  attribute: "data-composer-mention-chip" | "data-composer-skill-chip" | "data-composer-agent-chip",
): Promise<string[]> {
  return browser.execute((chipAttribute) => {
    return [...document.querySelectorAll<HTMLElement>(`[${chipAttribute}="true"]`)]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
          !element.closest(".hidden") &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0
        );
      })
      .map((element) => element.textContent?.trim() ?? "");
  }, attribute);
}

async function setComposerValue(value: string): Promise<void> {
  const editor = composerEditor();
  await expect(editor).toBeDisplayed();
  await editor.click();
  await browser.execute(() => {
    const editor = document.activeElement;
    if (!(editor instanceof HTMLElement) || editor.dataset.testid !== "composer-editor") {
      throw new Error("The composer editor did not receive focus.");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await browser.keys("Backspace");
  if (value.length > 0) {
    await editor.addValue(value);
  }
  await waitForComposerValue(value);
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
  if (await existingProject.isExisting()) {
    await existingProject.waitForDisplayed();
    return;
  }

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
  const newChatClicked = await browser.execute((projectName) => {
    const expectedLabel = `New main-branch chat in ${projectName}`;
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.ariaLabel === expectedLabel,
    );
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, desktopUiFixture.projectName);
  expect(newChatClicked).toBe(true);
  await waitForComposerDisplayed();
}

async function openProviderPanel(displayName: string): Promise<void> {
  const newPanelSelector = '[aria-label="New panel"]';
  await browser.waitUntil(
    async () => {
      for (const candidate of await browser.$$(newPanelSelector)) {
        if ((await candidate.isDisplayed()) && (await candidate.isEnabled())) {
          return true;
        }
      }
      return false;
    },
    {
      timeoutMsg: "The provider panel menu did not become available.",
    },
  );
  for (const candidate of await browser.$$(newPanelSelector)) {
    if ((await candidate.isDisplayed()) && (await candidate.isEnabled())) {
      await candidate.click();
      break;
    }
  }
  const provider = browser.$(`//*[@role="menuitem"][.//span[normalize-space()="${displayName}"]]`);
  await provider.waitForDisplayed();
  await provider.waitForEnabled();
  await provider.click();
  await browser.waitUntil(
    async () => {
      for (const candidate of await browser.$$(
        `//*[@role="menuitem"][.//span[normalize-space()="${displayName}"]]`,
      )) {
        if (await candidate.isDisplayed()) return false;
      }
      return true;
    },
    {
      timeoutMsg: `The ${displayName} panel menu did not close.`,
    },
  );
  const activeProviderTab = browser.$(
    `//*[contains(concat(" ", normalize-space(@class), " "), " bg-accent ") and ` +
      `.//button[@aria-label="Close ${displayName}"] and ` +
      `.//span[normalize-space()="${displayName}"]]`,
  );
  await activeProviderTab.waitForDisplayed();
  await waitForComposerDisplayed();
}

async function activateProviderPanel(displayName: string): Promise<void> {
  const closeSelector = `button[aria-label="Close ${displayName}"]`;
  const closeButton = browser.$(closeSelector);
  await closeButton.waitForExist();
  const activated = await browser.execute((selector) => {
    const close = document.querySelector<HTMLButtonElement>(selector);
    const tab = close?.closest<HTMLElement>("[data-active-tab]");
    const activate = [...(tab?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button !== close,
    );
    if (!tab || !activate) return false;
    if (tab.dataset.activeTab !== "true") {
      activate.click();
    }
    return true;
  }, closeSelector);
  expect(activated).toBe(true);
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector) =>
          document
            .querySelector(selector)
            ?.closest<HTMLElement>("[data-active-tab]")
            ?.getAttribute("data-active-tab") === "true",
        closeSelector,
      ),
    {
      timeoutMsg: `The ${displayName} provider panel did not become active.`,
    },
  );
  await waitForComposerDisplayed();
}

async function assertProviderLockedModelPicker(scenario: ProviderScenario): Promise<void> {
  const pickerTrigger = composerForm().$('[data-chat-provider-model-picker="true"]');
  await expect(pickerTrigger).toBeEnabled();
  await pickerTrigger.click();

  const pickerContent = browser.$('[data-model-picker-content="true"]');
  await pickerContent.waitForDisplayed();
  expect((await pickerContent.$$("[data-model-picker-provider]")).length).toBe(0);
  const semanticModelRowSelector = "[data-model-picker-instance-id][data-model-picker-model-slug]";
  const readVisibleModelRows = () =>
    browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-model-picker-content="true"] [data-slot="combobox-item"]',
        ),
      ]
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
        .map((element) => ({
          instanceId: element.dataset.modelPickerInstanceId ?? "",
          modelSlug: element.dataset.modelPickerModelSlug ?? "",
        })),
    );
  await browser.waitUntil(
    async () => {
      return (await readVisibleModelRows()).length > 0;
    },
    {
      timeoutMsg: `The ${scenario.displayName} model picker did not render any models.`,
    },
  );
  const modelRows = await readVisibleModelRows();
  expect((await pickerContent.$$(semanticModelRowSelector)).length).toBe(modelRows.length);
  expect(
    modelRows.every((row) => row.instanceId === scenario.provider && row.modelSlug.length > 0),
  ).toBe(true);
  expect(new Set(modelRows.map((row) => `${row.instanceId}:${row.modelSlug}`)).size).toBe(
    modelRows.length,
  );
  if (scenario.provider === "codex") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-provider-locked-model-picker.png"),
    );
  }
  await browser.keys("Escape");
  await pickerContent.waitForDisplayed({ reverse: true });
}

async function assertColonMenu(provider: ComposerProvider): Promise<void> {
  await setComposerValue(":");
  await waitForComposerItem("t4code-action:default");
  await assertComposerGroups(["t4code"]);
  const ids = await visibleComposerItemIds();
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every((id) => id.startsWith("t4code-action:"))).toBe(true);
  if (provider === "codex") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-colon-menu.png"),
    );
  }
  await clickVisibleComposerItem("t4code-action:default");
  await waitForComposerValue("");
}

async function assertSlashMenu(scenario: ProviderScenario): Promise<void> {
  const profile = composerProviderProfiles[scenario.provider];
  await setComposerValue("/");
  await waitForComposerItem(`provider-command:${scenario.provider}:${scenario.keyboardCommand}`);
  await assertComposerGroups([
    "commands",
    ...(profile.slashSkills.length > 0 ? (["skills"] as const) : []),
  ]);
  const ids = await visibleComposerItemIds();
  const expectedIds = [
    ...profile.commands.map((command) => `provider-command:${scenario.provider}:${command}`),
    ...profile.slashSkills.map((skill) => `provider-skill:${scenario.provider}:slash:${skill}`),
  ].toSorted();
  expect(ids.toSorted()).toEqual(expectedIds);
  if (scenario.provider === "claudeAgent") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-slash-groups.png"),
    );
  }

  await setComposerValue(`/${scenario.keyboardCommand}`);
  await waitForComposerItem(`provider-command:${scenario.provider}:${scenario.keyboardCommand}`);
  await composerEditor().click();
  await browser.keys("ArrowDown");
  await expect(
    browser.$(
      `[data-composer-item-id="provider-command:${scenario.provider}:${scenario.keyboardCommand}"][data-composer-item-active="true"]`,
    ),
  ).toBeDisplayed();
  await browser.keys("Enter");
  await waitForComposerValue(`/${scenario.keyboardCommand} `);
  await setComposerValue("");
}

async function assertDollarMenu(provider: ComposerProvider): Promise<void> {
  const profile = composerProviderProfiles[provider];
  await setComposerValue("$");
  if (profile.dollarSkills.length === 0) {
    await waitForComposerItemsToClose();
    await assertComposerGroups([]);
    return;
  }
  await assertComposerGroups(["skills"]);
  for (const skill of profile.dollarSkills) {
    await waitForComposerItem(`provider-skill:${provider}:dollar:${skill}`);
  }
  const ids = await visibleComposerItemIds();
  expect(ids.toSorted()).toEqual(
    profile.dollarSkills.map((skill) => `provider-skill:${provider}:dollar:${skill}`).toSorted(),
  );
  await setComposerValue("");
}

async function assertReferenceMenu(provider: ComposerProvider): Promise<void> {
  const expectedAgents = composerProviderProfiles[provider].mentionableAgents;
  await setComposerValue("@");
  await waitForComposerItem("file-reference:file:README.md");
  await assertComposerGroups([
    "files",
    ...(expectedAgents.length > 0 ? (["agents"] as const) : []),
  ]);
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
  await clickVisibleComposerItem("file-reference:file:README.md");
  await expect(composerForm().$('[data-composer-mention-chip="true"]')).toBeDisplayed();
  await setComposerValue("");
}

async function sendCurrentComposerPrompt(
  provider: ComposerProvider,
  prompt: string,
  initialLogLength: number,
): Promise<void> {
  const send = composerForm().$('button[aria-label="Send message"]');
  await expect(send).toBeEnabled();
  await send.click();
  await waitForProviderInputLogEntry(
    preparedProviderInputLogPath,
    initialLogLength,
    { provider, prompt },
    { timeoutMs: 20_000 },
  );
}

async function sendAndAssertNativePrompt(scenario: ProviderScenario): Promise<void> {
  const initialLogLength = readProviderInputLog(preparedProviderInputLogPath).length;
  await setComposerValue(scenario.nativePrompt);
  await sendCurrentComposerPrompt(scenario.provider, scenario.nativePrompt, initialLogLength);
}

async function selectAndSendReadmeReference(): Promise<void> {
  const initialLogLength = readProviderInputLog(preparedProviderInputLogPath).length;
  await setComposerValue("@README");
  await waitForComposerItem("file-reference:file:README.md");
  await clickVisibleComposerItem("file-reference:file:README.md");
  await expect(composerForm().$('[data-composer-mention-chip="true"]')).toBeDisplayed();
  await sendCurrentComposerPrompt("codex", "@README.md", initialLogLength);
}

async function selectAndSendClaudeDocsSkill(): Promise<void> {
  const initialLogLength = readProviderInputLog(preparedProviderInputLogPath).length;
  await setComposerValue("/doc");
  await waitForComposerItem("provider-skill:claudeAgent:slash:docs");
  await clickVisibleComposerItem("provider-skill:claudeAgent:slash:docs");
  await waitForComposerValue("/docs ");
  await sendCurrentComposerPrompt("claudeAgent", "/docs", initialLogLength);
}

async function openProviderPanelWithStaleMenu(
  current: ProviderScenario,
  next: ProviderScenario,
): Promise<void> {
  await setComposerValue(`/${current.keyboardCommand}`);
  const staleItemId = `provider-command:${current.provider}:${current.keyboardCommand}`;
  await waitForComposerItem(staleItemId);
  await composerEditor().click();
  await browser.keys("ArrowDown");
  await expect(
    browser.$(`[data-composer-item-id="${staleItemId}"][data-composer-item-active="true"]`),
  ).toBeDisplayed();

  await openProviderPanel(next.displayName);
  await waitForComposerValue("");
  await waitForComposerItemsToClose();
  await setComposerValue("/");
  await waitForComposerItem(`provider-command:${next.provider}:${next.keyboardCommand}`);
  expect((await visibleComposerItemIds()).some((id) => id.includes(`:${current.provider}:`))).toBe(
    false,
  );
  await setComposerValue("");
}

async function persistedDraftMatches(
  panelThreadId: string,
  expectedPrompt: string,
): Promise<boolean> {
  return browser.execute(
    (threadId, prompt) => {
      const rawStore = window.localStorage.getItem("t4code:composer-drafts:v1");
      if (!rawStore) return false;
      const parsed = JSON.parse(rawStore) as {
        state?: {
          draftsByThreadKey?: Record<string, { prompt?: string }>;
        };
      };
      return Object.entries(parsed.state?.draftsByThreadKey ?? {}).some(
        ([threadKey, draft]) => threadKey.endsWith(`:${threadId}`) && draft.prompt === prompt,
      );
    },
    panelThreadId,
    expectedPrompt,
  );
}

async function openCodeDraftChipsAreValid(): Promise<boolean> {
  const mentionChips = await visibleComposerChipTexts("data-composer-mention-chip");
  const skillChips = await visibleComposerChipTexts("data-composer-skill-chip");
  const agentChips = await visibleComposerChipTexts("data-composer-agent-chip");
  return (
    mentionChips.includes("README.md") && agentChips.includes("reviewer") && skillChips.length === 0
  );
}

async function codexDraftChipsAreValid(): Promise<boolean> {
  const mentionChips = await visibleComposerChipTexts("data-composer-mention-chip");
  const skillChips = await visibleComposerChipTexts("data-composer-skill-chip");
  const agentChips = await visibleComposerChipTexts("data-composer-agent-chip");
  return mentionChips.length === 0 && agentChips.length === 0 && skillChips.includes("Refactor");
}

async function persistProviderDraftsAndRestart(): Promise<void> {
  const persistedThread = browser.$('[data-testid^="thread-row-"][data-active="true"]');
  await persistedThread.waitForDisplayed();
  const persistedThreadTestId = await persistedThread.getAttribute("data-testid");
  const hostThreadId = persistedThreadTestId?.replace("thread-row-", "") ?? "";
  expect(hostThreadId.length).toBeGreaterThan(0);
  const persistedThreadSelector = `[data-testid="thread-row-${hostThreadId}"]`;
  const openCodePanelThreadId = await browser.execute((hostThreadId) => {
    const rawStore = window.localStorage.getItem("t4code:center-panel-state:v1");
    if (!rawStore) return null;
    const parsed = JSON.parse(rawStore) as {
      state?: {
        byThreadKey?: Record<
          string,
          {
            surfaces?: Array<{
              kind?: string;
              providerLabel?: string;
              threadId?: string;
            }>;
          }
        >;
      };
    };
    const hostPanels = Object.entries(parsed.state?.byThreadKey ?? {}).find(([threadKey]) =>
      threadKey.endsWith(`:${hostThreadId}`),
    )?.[1];
    return (
      hostPanels?.surfaces?.find(
        (surface) => surface.kind === "chat" && surface.providerLabel === "OpenCode",
      )?.threadId ?? null
    );
  }, hostThreadId);
  if (!openCodePanelThreadId) {
    throw new Error("The active host did not retain an OpenCode provider panel.");
  }

  const codexPrompt = "$refactor ";
  await activateProviderPanel("Main");
  await setComposerValue("");
  await appendAndSelectComposerItem("$ref", "provider-skill:codex:dollar:refactor");
  await browser.waitUntil(() => persistedDraftMatches(hostThreadId, codexPrompt), {
    timeoutMsg: "The Codex panel draft was not flushed to storage.",
  });
  await browser.waitUntil(codexDraftChipsAreValid, {
    timeoutMsg: "The Codex dollar skill did not render as a skill chip.",
  });

  const openCodePrompt = "opencode @README.md @reviewer $refactor ";
  await activateProviderPanel("OpenCode");
  await setComposerValue("opencode ");
  await appendAndSelectComposerItem("@README", "file-reference:file:README.md");
  await appendAndSelectComposerItem("@rev", "agent-reference:opencode:reviewer");
  await composerEditor().addValue("$refactor ");
  await browser.waitUntil(() => persistedDraftMatches(openCodePanelThreadId, openCodePrompt), {
    timeoutMsg: "The OpenCode panel draft was not flushed to storage.",
  });
  await browser.waitUntil(openCodeDraftChipsAreValid, {
    timeoutMsg:
      "The OpenCode draft did not render file and agent chips while leaving $refactor plain.",
  });

  await browser.reloadSession();
  await setDesktopUiWindowSize(1_100, 760);
  await expect(browser.$("#root")).toBeDisplayed();
  await ensureMainSidebarOpen();
  const restoredThread = browser.$(persistedThreadSelector);
  await restoredThread.waitForDisplayed();
  await restoredThread.click();
  await waitForComposerDisplayed();

  await activateProviderPanel("OpenCode");
  expect(await persistedDraftMatches(openCodePanelThreadId, openCodePrompt)).toBe(true);
  await browser.waitUntil(openCodeDraftChipsAreValid, {
    timeoutMsg: "The persisted OpenCode file and agent chips were not restored.",
  });
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "composer-restored-chips.png"),
  );

  await activateProviderPanel("Main");
  expect(await persistedDraftMatches(hostThreadId, codexPrompt)).toBe(true);
  await browser.waitUntil(codexDraftChipsAreValid, {
    timeoutMsg: "The persisted Codex dollar-skill chip was not restored.",
  });
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "composer-restored-codex-skill-chip.png"),
  );
}

function assertCompleteProviderInputLog(composerLogBaseline: number): void {
  const actualProviderInputs = readProviderInputLog(preparedProviderInputLogPath)
    .slice(composerLogBaseline)
    .map(({ provider, prompt }) => ({ provider, prompt }));
  expect(actualProviderInputs).toEqual(expectedProviderInputs);
  expect(actualProviderInputs.some(({ prompt }) => prompt.startsWith(":"))).toBe(false);
}

describe("packaged native composer triggers", () => {
  it("normalizes every provider, sends exact native syntax, closes stale menus, and restores chips", async () => {
    const composerLogBaseline = readProviderInputLog(preparedProviderInputLogPath).length;
    await setDesktopUiWindowSize(1_100, 760);
    await ensureFixtureProjectImported();
    await openInitialCodexDraft();

    for (const [index, scenario] of scenarios.entries()) {
      await assertProviderLockedModelPicker(scenario);
      await assertColonMenu(scenario.provider);
      await assertSlashMenu(scenario);
      await assertDollarMenu(scenario.provider);
      await assertReferenceMenu(scenario.provider);
      await sendAndAssertNativePrompt(scenario);
      if (scenario.provider === "codex") {
        await selectAndSendReadmeReference();
      }
      if (scenario.provider === "claudeAgent") {
        await selectAndSendClaudeDocsSkill();
      }

      const next = scenarios[index + 1];
      if (next) {
        await openProviderPanelWithStaleMenu(scenario, next);
      }
    }

    assertCompleteProviderInputLog(composerLogBaseline);
    await setComposerValue("/");
    await waitForComposerItem("provider-command:grok:skills");
    await persistProviderDraftsAndRestart();
  });
});
