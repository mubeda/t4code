// @effect-diagnostics nodeBuiltinImport:off - Contract tests inspect the packaged UI harness source.
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { mockDesktopUiFolderPicker } from "./ui-state.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mockDesktopUiFolderPicker", () => {
  it("returns the fixture path from the packaged Tauri folder-picker command", async () => {
    const mockReturnValue = vi.fn(async () => undefined);
    const mock = vi.fn(async () => ({ mockReturnValue }));
    vi.stubGlobal("browser", { tauri: { mock } });

    await mockDesktopUiFolderPicker("/tmp/t4code-ui-project");

    expect(mock).toHaveBeenCalledExactlyOnceWith("desktop_bridge_pick_folder");
    expect(mockReturnValue).toHaveBeenCalledExactlyOnceWith("/tmp/t4code-ui-project");
  });
});

describe("desktop UI motion stabilization", () => {
  it("keeps the WDIO motion guard from overriding open or closed portal styles", () => {
    const configuration = NodeFS.readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(configuration).not.toContain('document.createElement("style")');
    expect(configuration).toContain("sheet.insertRule");
    expect(configuration).toContain(
      'document.documentElement.dataset.t4codeDesktopUiMotion = "disabled"',
    );
    expect(configuration).not.toMatch(
      /style\.setProperty\("(?:opacity|scale|translate|transform)"/,
    );
    expect(configuration).not.toContain("new MutationObserver");
    expect(configuration).not.toMatch(/removeAttribute\("data-(?:starting|ending)-style"\)/);
  });

  it("settles stuck opening portals and hides closed portals through state-aware CSS", () => {
    const configuration = NodeFS.readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(configuration).toContain("[data-open][data-starting-style]");
    expect(configuration).toMatch(
      /\[data-open\]\[data-starting-style\]\s*\{[^}]*opacity:\s*1\s*!important;[^}]*\}/s,
    );
    expect(configuration).toMatch(/\[data-closed\]\s*\{[^}]*display:\s*none\s*!important;[^}]*\}/s);
  });

  it("settles auto-animated project rows without overriding unrelated content", () => {
    const configuration = NodeFS.readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(configuration).toMatch(
      /\[data-slot="sidebar-group"\]:has\(\[data-testid="new-main-chat-button"\]\)\s+ul\[data-sidebar="menu"\]\s*>\s*li\s*\{[^}]*opacity:\s*1\s*!important;[^}]*\}/s,
    );
    expect(configuration).not.toMatch(/(?:^|,)\s*li\s*\{[^}]*opacity:/s);
  });

  it("leaves portal lifecycle state to Base UI in every smoke spec", () => {
    for (const spec of ["../specs/main-window.e2e.ts", "../specs/platform-capabilities.e2e.ts"]) {
      const source = NodeFS.readFileSync(new URL(spec, import.meta.url), "utf8");
      expect(source).not.toContain("stabilizeDesktopUiTransitions");
    }
  });
});

describe("packaged composer acceptance contract", () => {
  const readComposerSpec = (): string =>
    NodeFS.readFileSync(
      new URL("../specs/composer-native-triggers.e2e.ts", import.meta.url),
      "utf8",
    );

  it("checks every visible model row through semantic provider and model attributes", () => {
    const source = readComposerSpec();

    expect(source).toContain("[data-model-picker-instance-id][data-model-picker-model-slug]");
    expect(source).toContain("row.instanceId === scenario.provider");
    expect(source).toContain("row.modelSlug.length > 0");
    expect(source).not.toContain("foreignModels");
  });

  it("restarts the packaged session and compares the complete native provider payload sequence", () => {
    const source = readComposerSpec();

    expect(source).toContain("await browser.reloadSession()");
    expect(source).not.toContain("await browser.refresh()");
    expect(source).toContain(
      "const composerLogBaseline = readProviderInputLog(preparedProviderInputLogPath).length",
    );
    expect(source).toContain(".slice(composerLogBaseline)");
    expect(source.match(/await activateProviderPanel\("Main"\)/g)).toHaveLength(2);
    expect(source).toContain("expect(actualProviderInputs).toEqual(expectedProviderInputs)");
    for (const prompt of [
      '"$refactor"',
      '"@README.md"',
      '"/compact"',
      '"/docs"',
      '"/review"',
      '"@reviewer"',
      '"/skills"',
    ]) {
      expect(source).toContain(prompt);
    }
  });
});
