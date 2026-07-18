import { describe, expect, it } from "vite-plus/test";

import { DesktopAppPathConfigurationError, resolveDesktopAppPath } from "./app-path.ts";

describe("resolveDesktopAppPath", () => {
  it("resolves the executable inside a macOS app mounted from a DMG", () => {
    expect(
      resolveDesktopAppPath({
        platform: "mac",
        environment: {
          T4CODE_E2E_APP_PATH: "/Volumes/T4Code/T4Code (Alpha).app",
        },
      }),
    ).toBe("/Volumes/T4Code/T4Code (Alpha).app/Contents/MacOS/t4code-desktop");
  });

  it("accepts a direct macOS application executable", () => {
    const executable = "/private/tmp/T4Code (Alpha).app/Contents/MacOS/T4Code (Alpha)";

    expect(
      resolveDesktopAppPath({
        platform: "mac",
        environment: { T4CODE_E2E_APP_PATH: executable },
      }),
    ).toBe(executable);
  });

  it("resolves a Linux AppImage without changing paths that contain spaces", () => {
    const appImage = "/tmp/T4Code UI Smoke/T4Code_0.2.2_amd64.AppImage";

    expect(
      resolveDesktopAppPath({
        platform: "linux",
        environment: { T4CODE_E2E_APP_PATH: appImage },
      }),
    ).toBe(appImage);
  });

  it("resolves an NSIS-installed Windows executable with win32 path rules", () => {
    const executable = String.raw`C:\Program Files\T4Code\T4Code (Alpha).exe`;

    expect(
      resolveDesktopAppPath({
        platform: "win",
        environment: { T4CODE_E2E_APP_PATH: executable },
      }),
    ).toBe(executable);
  });

  it("rejects a missing T4CODE_E2E_APP_PATH", () => {
    expect(() =>
      resolveDesktopAppPath({
        platform: "linux",
        environment: {},
      }),
    ).toThrowError(DesktopAppPathConfigurationError);
  });

  it("rejects installer paths that are not directly launchable", () => {
    expect(() =>
      resolveDesktopAppPath({
        platform: "mac",
        environment: { T4CODE_E2E_APP_PATH: "/tmp/T4Code.dmg" },
      }),
    ).toThrowError(/mount the DMG/i);

    expect(() =>
      resolveDesktopAppPath({
        platform: "win",
        environment: { T4CODE_E2E_APP_PATH: String.raw`C:\tmp\T4Code-setup.msi` },
      }),
    ).toThrowError(/installed executable/i);
  });
});
