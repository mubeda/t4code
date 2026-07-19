// @effect-diagnostics nodeBuiltinImport:off - The standalone build adapter launches Tauri.
import * as NodeChildProcess from "node:child_process";

import type { DesktopUiPlatform } from "./app-path.ts";

const bundles: Record<DesktopUiPlatform, string> = {
  linux: "appimage",
  mac: "dmg",
  win: "nsis",
};

export interface PackagedDesktopUiBuildInput {
  readonly platform: DesktopUiPlatform;
  readonly bundle?: string;
}

export interface PackagedDesktopUiBuildPlan {
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

export function planPackagedDesktopUiBuild(
  input: PackagedDesktopUiBuildInput,
): PackagedDesktopUiBuildPlan {
  const bundle = input.bundle ?? bundles[input.platform];
  return {
    environment: {
      VITE_T4CODE_DESKTOP_E2E: "1",
    },
    args: [
      "../../scripts/run-msvc-x64.mjs",
      "pnpm",
      "exec",
      "tauri",
      "build",
      "--features",
      "desktop-e2e",
      "--config",
      "./src-tauri/tauri.e2e.conf.json",
      "--bundles",
      bundle,
    ],
  };
}

function configuredPlatform(): DesktopUiPlatform {
  if (
    process.env.T4CODE_E2E_PLATFORM === "linux" ||
    process.env.T4CODE_E2E_PLATFORM === "mac" ||
    process.env.T4CODE_E2E_PLATFORM === "win"
  ) {
    return process.env.T4CODE_E2E_PLATFORM;
  }
  // oxlint-disable-next-line t4code/no-global-process-runtime -- The standalone build CLI selects its native host target.
  return process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
}

function run(): void {
  const plan = planPackagedDesktopUiBuild({
    platform: configuredPlatform(),
    ...(process.env.T4CODE_E2E_BUNDLE ? { bundle: process.env.T4CODE_E2E_BUNDLE } : {}),
  });
  const result = NodeChildProcess.spawnSync(process.execPath, [...plan.args], {
    env: { ...process.env, ...plan.environment },
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (import.meta.main) run();
