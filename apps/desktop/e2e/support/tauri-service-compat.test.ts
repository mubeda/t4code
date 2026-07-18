// @effect-diagnostics nodeBuiltinImport:off - Compatibility tests inspect packaged source contracts.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("@wdio/tauri-service compatibility", () => {
  it("loads with the native utility API used by the published service", async () => {
    const service = await import("@wdio/tauri-service");

    expect(service.default).toBeTypeOf("function");
    expect(service.launcher).toBeTypeOf("function");
  });

  it("packages both test-only Tauri plugins and grants the service IPC capability", () => {
    const cargoManifest = NodeFS.readFileSync(
      new URL("../../src-tauri/Cargo.toml", import.meta.url),
      "utf8",
    );
    const desktopLibrary = NodeFS.readFileSync(
      new URL("../../src-tauri/src/lib.rs", import.meta.url),
      "utf8",
    );
    const webEntry = NodeFS.readFileSync(
      new URL("../../../web/src/main.tsx", import.meta.url),
      "utf8",
    );
    const e2eConfig = JSON.parse(
      NodeFS.readFileSync(new URL("../../src-tauri/tauri.e2e.conf.json", import.meta.url), "utf8"),
    ) as {
      readonly app: {
        readonly withGlobalTauri: boolean;
        readonly security: {
          readonly capabilities: ReadonlyArray<{
            readonly permissions: ReadonlyArray<string>;
          }>;
        };
      };
    };

    expect(cargoManifest).toContain(
      'desktop-e2e = ["dep:tauri-plugin-wdio", "dep:tauri-plugin-wdio-webdriver"]',
    );
    expect(desktopLibrary).toContain("t4code_server::logging::initialize");
    const loggingPluginIndex = desktopLibrary.indexOf(".plugin(desktop_e2e_logging_plugin())");
    const wdioPluginIndex = desktopLibrary.indexOf(".plugin(tauri_plugin_wdio::init())");
    expect(loggingPluginIndex).toBeGreaterThan(-1);
    expect(loggingPluginIndex).toBeLessThan(wdioPluginIndex);
    expect(desktopLibrary).toContain(".plugin(tauri_plugin_wdio::init())");
    expect(desktopLibrary).toContain(".plugin(tauri_plugin_wdio_webdriver::init())");
    expect(webEntry).toContain('import("@wdio/tauri-plugin")');
    expect(webEntry).not.toContain('from "./tauriDesktopBridge"');
    expect(webEntry.indexOf('import("@wdio/tauri-plugin")')).toBeLessThan(
      webEntry.indexOf('import("./bootstrap")'),
    );
    expect(e2eConfig.app.withGlobalTauri).toBe(true);
    expect(e2eConfig.app.security.capabilities[0]?.permissions).toContain("wdio:default");
  });
});
