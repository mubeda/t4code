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
      /\[data-slot="sidebar-group"\]:has\(\[data-testid="sidebar-new-main-chat-trigger"\]\)\s+ul\[data-sidebar="menu"\]\s*>\s*li\s*\{[^}]*opacity:\s*1\s*!important;[^}]*\}/s,
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
