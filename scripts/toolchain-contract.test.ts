// @effect-diagnostics nodeBuiltinImport:off - Toolchain contracts inspect checked-in files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, path), "utf8")) as Record<
    string,
    unknown
  >;
}

function readText(path: string): string {
  return NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, path), "utf8");
}

describe("repository toolchain contract", () => {
  it("pins Node, pnpm, Node types, and the paired Vite+ packages", () => {
    const rootPackage = readJson("package.json");
    const workspace = readText("pnpm-workspace.yaml");
    const workspaceConfiguration = parseYaml(workspace) as Record<string, unknown>;

    expect(rootPackage.engines).toEqual({ node: "26.5.0" });
    expect(rootPackage.packageManager).toBe("pnpm@11.15.0");
    expect(workspace).toMatch(/^  "@types\/node": 26\.1\.1$/m);
    expect(workspace).toMatch(/^  vite: npm:@voidzero-dev\/vite-plus-core@0\.2\.5$/m);
    expect(workspace).toMatch(/^  vite-plus: 0\.2\.5$/m);
    expect(workspaceConfiguration.minimumReleaseAgeExclude).toEqual([
      "geckodriver@6.1.1",
      "@cloudflare/workers-types@5.20260718.1",
      "@tanstack/router-generator@1.167.21",
      "@tanstack/router-plugin@1.168.22",
    ]);
    expect(workspace).not.toMatch(/^trustLockfile:\s+true$/m);
    expect(workspaceConfiguration).not.toHaveProperty("ignoredBuiltDependencies");
    expect(workspaceConfiguration).not.toHaveProperty("onlyBuiltDependencies");
    expect(workspaceConfiguration.allowBuilds).toEqual({
      "bufferutil@4.1.0": false,
      "edgedriver@6.3.0": false,
      "esbuild@0.25.12 || 0.28.1": true,
      "geckodriver@6.1.1": false,
      "msgpackr-extract@3.0.4": true,
      "msw@2.15.0": false,
      "sharp@0.34.5": true,
      "utf-8-validate@6.0.6": false,
      "workerd@1.20260704.1": false,
    });
  });

  it("uses stable TypeScript 7 through the patched Effect compiler", () => {
    const rootPackage = readJson("package.json");
    const rootScripts = rootPackage.scripts as Record<string, string>;
    const rootDevDependencies = rootPackage.devDependencies as Record<string, string>;
    const marketingPackage = readJson("apps/marketing/package.json");
    const marketingDevDependencies = marketingPackage.devDependencies as Record<string, string>;
    const workspace = parseYaml(readText("pnpm-workspace.yaml")) as Record<string, unknown>;
    const catalog = workspace.catalog as Record<string, string>;
    const peerDependencyRules = workspace.peerDependencyRules as Record<string, unknown>;

    expect(catalog["@effect/tsgo"]).toBe("0.24.1");
    expect(catalog.typescript).toBe("7.0.2");
    expect(catalog).not.toHaveProperty("@typescript/native-preview");
    expect(rootDevDependencies).not.toHaveProperty("@typescript/native-preview");
    expect(rootDevDependencies.typescript).toBe("catalog:");
    expect(marketingDevDependencies.typescript).toBe("6.0.3");
    expect(rootScripts.prepare).toBe("effect-tsgo patch");
    expect(peerDependencyRules.allowedVersions).toEqual({
      "ws@7.5.11>utf-8-validate": "6.0.6",
      vite: "*",
    });

    for (const packagePath of [
      "apps/desktop/package.json",
      "apps/web/package.json",
      "infra/relay/package.json",
      "oxlint-plugin-t4code/package.json",
      "packages/client-runtime/package.json",
      "packages/contracts/package.json",
      "packages/shared/package.json",
      "scripts/package.json",
    ]) {
      const packageJson = readJson(packagePath);
      const scripts = packageJson.scripts as Record<string, string>;

      expect(scripts.typecheck, packagePath).toContain("tsc");
      expect(scripts.typecheck, packagePath).not.toContain("tsgo");
    }
  });

  it("pins Rust with formatting and lint components everywhere", () => {
    const rustToolchain = parseToml(readText("rust-toolchain.toml"));
    const cargo = parseToml(readText("Cargo.toml"));
    const toolchain = rustToolchain.toolchain as Record<string, unknown>;
    const workspace = cargo.workspace as Record<string, unknown>;
    const workspacePackage = workspace.package as Record<string, unknown>;

    expect(toolchain.channel).toBe("1.97.1");
    expect(toolchain.profile).toBe("minimal");
    expect(toolchain.components).toEqual(["rustfmt", "clippy"]);
    expect(workspacePackage["rust-version"]).toBe("1.97.1");

    for (const workflowPath of [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      ".github/workflows/desktop-ui-smoke.yml",
    ]) {
      const workflow = readText(workflowPath);
      expect(workflow).not.toMatch(/dtolnay\/rust-toolchain@(stable|1\.88(?:\.0)?)/);
      expect(workflow).toMatch(/dtolnay\/rust-toolchain@[0-9a-f]{40} # 1\.97\.1/);
    }
  });

  it("uses an immutable devcontainer without Bun and installs through Corepack", () => {
    const devcontainer = readJson(".devcontainer/devcontainer.json");
    const features = devcontainer.features as Record<string, unknown>;

    expect(devcontainer.image).toBe(
      "debian:bookworm@sha256:9344f8b8992482f80cba753f323adeaf17690076c095ccff6cc9536be98185dc",
    );
    expect(Object.keys(features)).toEqual([
      "ghcr.io/devcontainers/features/git:1.3.8",
      "ghcr.io/devcontainers/features/node:2.1.0",
      "ghcr.io/devcontainers/features/python:1.8.0",
    ]);
    expect(Object.keys(features).some((feature) => /(?:^|\/)bun:/.test(feature))).toBe(false);
    expect(features["ghcr.io/devcontainers/features/node:2.1.0"]).toEqual({
      version: "26.5.0",
    });
    expect(devcontainer.postCreateCommand).toEqual({
      install:
        "npm install --global corepack@0.35.0 && corepack enable && corepack prepare pnpm@11.15.0 --activate && pnpm install --frozen-lockfile",
    });
  });

  it("runs the locked Tauri CLI from the desktop workspace", () => {
    const desktopPackage = readJson("apps/desktop/package.json");
    const scripts = desktopPackage.scripts as Record<string, string>;
    const devDependencies = desktopPackage.devDependencies as Record<string, string>;

    expect(devDependencies["@tauri-apps/cli"]).toBe("2.11.4");
    expect(scripts.dev).toContain("pnpm exec tauri dev");
    expect(scripts.build).toContain("pnpm exec tauri build");
    expect(Object.values(scripts).join("\n")).not.toContain("pnpm dlx");
  });
});
