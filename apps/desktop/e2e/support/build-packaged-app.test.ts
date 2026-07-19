import { describe, expect, it } from "vite-plus/test";

import { planPackagedDesktopUiBuild } from "./build-packaged-app.ts";

describe("planPackagedDesktopUiBuild", () => {
  it.each([
    ["mac", "dmg"],
    ["linux", "appimage"],
    ["win", "nsis"],
  ] as const)("places the %s bundle before Cargo arguments", (platform, bundle) => {
    const plan = planPackagedDesktopUiBuild({ platform });

    expect(plan.args).toEqual(
      expect.arrayContaining([
        "exec",
        "tauri",
        "build",
        "--features",
        "desktop-e2e",
        "--config",
        "./src-tauri/tauri.e2e.conf.json",
        "--bundles",
        bundle,
      ]),
    );
    expect(plan.args).not.toContain("--");
    expect(plan.environment).toEqual({
      VITE_T4CODE_DESKTOP_E2E: "1",
    });
  });
});
