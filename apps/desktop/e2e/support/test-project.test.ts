// @effect-diagnostics nodeBuiltinImport:off - Desktop UI fixture tests inspect host temp files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  archiveAndCleanupDesktopUiTestContext,
  composerProviderProfiles,
  deferDesktopUiTestContextCleanupUntilExit,
  prepareDesktopUiTestContext,
  type DesktopUiDirectoryRemover,
  type DesktopUiExitRegistrar,
  type DesktopUiTestContext,
} from "./test-project.ts";

const contexts: DesktopUiTestContext[] = [];

afterEach(() => {
  for (const context of contexts.splice(0)) {
    archiveAndCleanupDesktopUiTestContext(context);
  }
});

describe.each([
  { platform: "mac", executableSuffix: "" },
  { platform: "linux", executableSuffix: "" },
  { platform: "win", executableSuffix: ".cmd" },
])("prepareDesktopUiTestContext on $platform", ({ platform, executableSuffix }) => {
  it("pins every provider to an absolute fixture executable", () => {
    const environment: NodeJS.ProcessEnv = { T4CODE_E2E_PLATFORM: platform };
    const context = prepareDesktopUiTestContext(environment);
    contexts.push(context);

    const settingsPath = NodePath.join(context.stateRoot, "userdata", "settings.json");
    const settings = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as {
      readonly providers: Record<
        string,
        { readonly enabled: boolean; readonly binaryPath: string }
      >;
    };
    const expectedExecutable = (name: string): string =>
      NodePath.join(context.shimDirectory, `${name}${executableSuffix}`);

    expect(settings.providers.codex?.binaryPath).toBe(expectedExecutable("codex"));
    expect(settings.providers.claudeAgent?.binaryPath).toBe(expectedExecutable("claude"));
    expect(settings.providers.cursor?.binaryPath).toBe(expectedExecutable("cursor-agent"));
    expect(settings.providers.grok?.binaryPath).toBe(expectedExecutable("grok"));
    expect(settings.providers.opencode?.binaryPath).toBe(expectedExecutable("opencode"));
    expect(settings.providers.codex?.enabled).toBe(true);
    expect(settings.providers.claudeAgent?.enabled).toBe(true);
    expect(settings.providers.cursor?.enabled).toBe(true);
    expect(settings.providers.grok?.enabled).toBe(true);
    expect(settings.providers.opencode?.enabled).toBe(true);
    for (const provider of Object.values(settings.providers)) {
      expect(NodePath.isAbsolute(provider.binaryPath)).toBe(true);
    }
    expect(environment.T4CODE_E2E_SHIM_DIRECTORY).toBe(context.shimDirectory);
  });

  it("isolates provider user inventory inside the disposable run root", () => {
    const environment: NodeJS.ProcessEnv = {
      T4CODE_E2E_PLATFORM: platform,
      HOME: "/host/home-must-not-be-used",
      USERPROFILE: String.raw`C:\Users\host-must-not-be-used`,
    };
    const context = prepareDesktopUiTestContext(environment);
    contexts.push(context);
    const expectedFixtureUserHome = NodePath.join(context.runRoot, "fixture-user-home");

    expect(context.fixtureUserHomePath).toBe(expectedFixtureUserHome);
    expect(NodePath.isAbsolute(context.fixtureUserHomePath)).toBe(true);
    expect(context.fixtureUserHomePath.startsWith(`${context.runRoot}${NodePath.sep}`)).toBe(true);
    expect(environment.T4CODE_E2E_USER_HOME).toBe(expectedFixtureUserHome);
    for (const relativePath of [
      ".cursor/commands/review.md",
      ".cursor/skills/frontend/SKILL.md",
      ".cursor/agents/cursor-prose-agent.md",
    ]) {
      expect(
        NodeFS.readFileSync(NodePath.join(context.fixtureUserHomePath, relativePath), "utf8"),
      ).not.toBe("");
    }
    const settings = JSON.parse(
      NodeFS.readFileSync(NodePath.join(context.stateRoot, "userdata", "settings.json"), "utf8"),
    ) as {
      readonly providerInstances?: Record<
        string,
        {
          readonly driver: string;
          readonly environment: ReadonlyArray<{
            readonly name: string;
            readonly value: string;
            readonly sensitive: boolean;
          }>;
        }
      >;
    };
    expect(settings.providerInstances?.cursor).toEqual({
      driver: "cursor",
      enabled: true,
      environment: [
        {
          name: platform === "win" ? "USERPROFILE" : "HOME",
          value: expectedFixtureUserHome,
          sensitive: false,
        },
      ],
    });
    if (platform === "win") {
      expect(environment.USERPROFILE).toBe(expectedFixtureUserHome);
      expect(environment.HOME).toBe(expectedFixtureUserHome);
    } else {
      expect(environment.HOME).toBe(expectedFixtureUserHome);
      expect(environment.USERPROFILE).toBe(String.raw`C:\Users\host-must-not-be-used`);
    }
  });
});

describe("packaged provider composer fixture", () => {
  it("exports the real normalized inline capability profiles", () => {
    expect(composerProviderProfiles).toEqual({
      codex: {
        commands: ["goal"],
        slashSkills: [],
        dollarSkills: ["refactor"],
        mentionableAgents: [],
      },
      claudeAgent: {
        commands: ["compact", "goal", "loop"],
        slashSkills: ["docs"],
        dollarSkills: [],
        mentionableAgents: [],
      },
      cursor: {
        commands: [
          "review",
          "models",
          "auto-run",
          "new-chat",
          "vim",
          "help",
          "feedback",
          "resume",
          "copy-req-id",
          "rules",
          "commands",
          "mcp",
          "max-mode",
          "compress",
          "add-plugin",
          "logout",
          "quit",
        ],
        slashSkills: ["frontend"],
        dollarSkills: [],
        mentionableAgents: [],
      },
      opencode: {
        commands: ["init"],
        slashSkills: [],
        dollarSkills: [],
        mentionableAgents: ["reviewer", "operator"],
      },
      grok: {
        commands: ["loop", "agents", "skills"],
        slashSkills: [],
        dollarSkills: [],
        mentionableAgents: [],
      },
    });
  });

  it("writes provider-native workspace metadata and exports an absolute input log", () => {
    const environment: NodeJS.ProcessEnv = { T4CODE_E2E_PLATFORM: "mac" };
    const context = prepareDesktopUiTestContext(environment);
    contexts.push(context);

    for (const relativePath of [
      ".claude/skills/docs/SKILL.md",
      ".cursor/commands/review.md",
      ".cursor/skills/frontend/SKILL.md",
      ".cursor/agents/cursor-prose-agent.md",
    ]) {
      expect(
        NodeFS.readFileSync(NodePath.join(context.projectPath, relativePath), "utf8"),
      ).not.toBe("");
    }
    expect(NodePath.isAbsolute(context.providerInputLogPath)).toBe(true);
    expect(environment.T4CODE_E2E_PROVIDER_INPUT_LOG).toBe(context.providerInputLogPath);
  });

  it("generates native protocol fixtures while keeping hidden and prose-only agents inline-inert", () => {
    const environment: NodeJS.ProcessEnv = { T4CODE_E2E_PLATFORM: "mac" };
    const context = prepareDesktopUiTestContext(environment);
    contexts.push(context);
    const fixtureSource = (name: string): string =>
      NodeFS.readFileSync(NodePath.join(context.shimDirectory, `${name}-fixture.mjs`), "utf8");

    expect(fixtureSource("codex")).toContain('"skills/list"');
    expect(fixtureSource("codex")).toContain('"refactor"');
    expect(fixtureSource("claude")).toContain('"compact"');
    expect(fixtureSource("claude")).toContain('"docs"');
    expect(fixtureSource("claude")).toContain('"claude-prose-agent"');
    expect(fixtureSource("cursor-agent")).toContain('"cursor/list_available_models"');
    expect(fixtureSource("opencode")).toContain('"primary"');
    expect(fixtureSource("opencode")).toContain('"subagent"');
    expect(fixtureSource("opencode")).toContain('"all"');
    expect(fixtureSource("opencode")).toContain('"secret"');
    expect(fixtureSource("grok")).toContain('"session/create"');
    expect(fixtureSource("grok")).toContain('"session/prompt"');

    expect(composerProviderProfiles.claudeAgent.mentionableAgents).not.toContain(
      "claude-prose-agent",
    );
    expect(composerProviderProfiles.cursor.mentionableAgents).not.toContain("cursor-prose-agent");
    expect(composerProviderProfiles.opencode.mentionableAgents).not.toContain("secret");
    expect(composerProviderProfiles.opencode.mentionableAgents).not.toContain("writer");
  });
});

describe("archiveAndCleanupDesktopUiTestContext", () => {
  it("configures retries for transient Windows locks while removing the run directory", () => {
    const runRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4code-cleanup-"));
    const artifactDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t4code-cleanup-artifacts-"),
    );
    const context: DesktopUiTestContext = {
      runRoot,
      stateRoot: NodePath.join(runRoot, "missing-state"),
      projectPath: NodePath.join(runRoot, "project"),
      shimDirectory: NodePath.join(runRoot, "shims"),
      artifactDirectory,
      fixtureUserHomePath: NodePath.join(runRoot, "fixture-user-home"),
      providerInputLogPath: NodePath.join(runRoot, "provider-input.jsonl"),
    };
    let removalOptions: Parameters<DesktopUiDirectoryRemover>[1] | undefined;
    const removeDirectory: DesktopUiDirectoryRemover = (path, options) => {
      removalOptions = options;
      NodeFS.rmSync(path, options);
    };

    try {
      archiveAndCleanupDesktopUiTestContext(context, removeDirectory);

      expect(removalOptions).toEqual({
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      expect(NodeFS.existsSync(runRoot)).toBe(false);
    } finally {
      NodeFS.rmSync(runRoot, { recursive: true, force: true });
      NodeFS.rmSync(artifactDirectory, { recursive: true, force: true });
    }
  });
});

describe("deferDesktopUiTestContextCleanupUntilExit", () => {
  it("waits for launcher services to stop before cleaning the shared fixture", () => {
    const context = {} as DesktopUiTestContext;
    let exitListener: (() => void) | undefined;
    let cleanedContext: DesktopUiTestContext | undefined;
    const exitRegistrar: DesktopUiExitRegistrar = {
      once: (event, listener) => {
        expect(event).toBe("exit");
        exitListener = listener;
      },
    };

    deferDesktopUiTestContextCleanupUntilExit(context, exitRegistrar, (cleaned) => {
      cleanedContext = cleaned;
    });

    expect(cleanedContext).toBeUndefined();
    expect(exitListener).toBeTypeOf("function");
    exitListener?.();
    expect(cleanedContext).toBe(context);
  });
});
