// @effect-diagnostics nodeBuiltinImport:off - Desktop UI fixture tests inspect host temp files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  archiveAndCleanupDesktopUiTestContext,
  prepareDesktopUiTestContext,
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
    expect(settings.providers.claudeAgent?.enabled).toBe(false);
    expect(settings.providers.cursor?.enabled).toBe(false);
    expect(settings.providers.grok?.enabled).toBe(false);
    expect(settings.providers.opencode?.enabled).toBe(false);
    expect(environment.T4CODE_E2E_SHIM_DIRECTORY).toBe(context.shimDirectory);
  });
});
