// @effect-diagnostics nodeBuiltinImport:off - Workflow contract tests inspect checked-in YAML directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const CI_WORKFLOW_PATH = NodePath.join(REPOSITORY_ROOT, ".github/workflows/ci.yml");
const RELEASE_WORKFLOW_PATH = NodePath.join(REPOSITORY_ROOT, ".github/workflows/release.yml");
const DESKTOP_UI_WORKFLOW_PATH = NodePath.join(
  REPOSITORY_ROOT,
  ".github/workflows/desktop-ui-smoke.yml",
);

interface WorkflowStep {
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly "runs-on"?: string;
  readonly strategy?: {
    readonly "fail-fast"?: boolean;
    readonly matrix?: {
      readonly include?: ReadonlyArray<Record<string, string>>;
    };
  };
  readonly steps?: ReadonlyArray<WorkflowStep>;
}

interface Workflow {
  readonly on?: Record<string, unknown>;
  readonly jobs?: Record<string, WorkflowJob>;
}

function readWorkflow(path: string): { readonly raw: string; readonly workflow: Workflow } {
  const raw = NodeFS.readFileSync(path, "utf8");
  return { raw, workflow: parseYaml(raw) as Workflow };
}

function requireJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (job === undefined) throw new Error(`Missing workflow job ${name}`);
  return job;
}

function allStepCommands(job: WorkflowJob): string {
  return (job.steps ?? [])
    .map((step) => [step.name, step.if, step.run, step.uses, JSON.stringify(step.with)].join("\n"))
    .join("\n");
}

describe("cross-platform CI contract", () => {
  it("keeps portable validation on Ubuntu 24.04", () => {
    const { workflow } = readWorkflow(CI_WORKFLOW_PATH);

    for (const name of ["check", "test", "release_smoke"]) {
      expect(requireJob(workflow, name)["runs-on"]).toBe("ubuntu-24.04");
    }
  });

  it("builds native desktop bundles on every supported runner and architecture", () => {
    const { workflow } = readWorkflow(CI_WORKFLOW_PATH);
    const nativeJob = requireJob(workflow, "native_desktop");
    const matrix = nativeJob.strategy?.matrix?.include ?? [];

    expect(nativeJob.strategy?.["fail-fast"]).toBe(false);
    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runner: "ubuntu-22.04",
          platform: "linux",
          target: "appimage",
          arch: "x64",
        }),
        expect.objectContaining({
          runner: "windows-2025",
          platform: "win",
          target: "nsis",
          arch: "x64",
        }),
        expect.objectContaining({
          runner: "macos-26",
          platform: "mac",
          target: "dmg",
          arch: "arm64",
        }),
        expect.objectContaining({
          runner: "macos-26-intel",
          platform: "mac",
          target: "dmg",
          arch: "x64",
        }),
      ]),
    );
    expect(matrix.some((entry) => entry.platform === "win" && entry.arch === "arm64")).toBe(false);
  });

  it("performs frozen install, version assertions, web build, Rust tests, and bundle build", () => {
    const { workflow } = readWorkflow(CI_WORKFLOW_PATH);
    const commands = allStepCommands(requireJob(workflow, "native_desktop"));

    expect(commands).toMatch(/vp install --frozen-lockfile/);
    expect(commands).toMatch(/node --version/);
    expect(commands).toMatch(/pnpm --version/);
    expect(commands).toMatch(/rustc --version/);
    expect(commands).toMatch(/vp run --filter @t4code\/web build/);
    expect(commands).toMatch(/vp run --filter @t4code\/desktop test/);
    expect(commands).toMatch(/node scripts\/build-desktop-artifact\.ts/);
    expect(commands).not.toMatch(/gh release|softprops\/action-gh-release/);
  });

  it("installs the full official Linux Tauri prerequisite set", () => {
    const { workflow } = readWorkflow(CI_WORKFLOW_PATH);
    const commands = allStepCommands(requireJob(workflow, "native_desktop"));

    for (const dependency of [
      "build-essential",
      "curl",
      "wget",
      "file",
      "libxdo-dev",
      "libssl-dev",
      "libgtk-3-dev",
      "libwebkit2gtk-4.1-dev",
      "libayatana-appindicator3-dev",
      "librsvg2-dev",
      "patchelf",
    ]) {
      expect(commands).toContain(dependency);
    }
    expect(commands).not.toContain("libappindicator3-dev");
  });
});

describe("cross-platform release contract", () => {
  it("builds AppImage on Ubuntu 22.04 with the complete Linux prerequisites", () => {
    const { workflow } = readWorkflow(RELEASE_WORKFLOW_PATH);
    const build = requireJob(workflow, "build");
    const linux = (build.strategy?.matrix?.include ?? []).find(
      (entry) => entry.platform === "linux",
    );
    const commands = allStepCommands(build);

    expect(linux?.runner).toBe("ubuntu-22.04");
    expect(commands).toContain("libayatana-appindicator3-dev");
    expect(commands).not.toContain("libappindicator3-dev");
    expect(commands).toContain("patchelf");
  });

  it("does not reintroduce scheduled nightly releases", () => {
    const ci = readWorkflow(CI_WORKFLOW_PATH);
    const release = readWorkflow(RELEASE_WORKFLOW_PATH);

    expect(ci.workflow.on?.schedule).toBeUndefined();
    expect(release.workflow.on?.schedule).toBeUndefined();
    expect(release.raw).toMatch(/workflow_dispatch:/);
    expect(release.raw).toMatch(/- nightly/);
  });
});

describe("packaged desktop UI smoke contract", () => {
  it("is manual and reusable without scheduled or release publishing triggers", () => {
    const { raw, workflow } = readWorkflow(DESKTOP_UI_WORKFLOW_PATH);

    expect(workflow.on?.workflow_dispatch).toBeDefined();
    expect(workflow.on?.workflow_call).toBeDefined();
    expect(workflow.on?.schedule).toBeUndefined();
    expect(raw).not.toMatch(/softprops\/action-gh-release|gh release|npm publish/);
  });

  it("builds and tests packaged applications on all supported native runners", () => {
    const { workflow } = readWorkflow(DESKTOP_UI_WORKFLOW_PATH);
    const smoke = requireJob(workflow, "desktop_ui_smoke");
    const matrix = smoke.strategy?.matrix?.include ?? [];
    const commands = allStepCommands(smoke);

    expect(smoke.strategy?.["fail-fast"]).toBe(false);
    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runner: "ubuntu-22.04", platform: "linux", arch: "x64" }),
        expect.objectContaining({ runner: "windows-2025", platform: "win", arch: "x64" }),
        expect.objectContaining({ runner: "macos-26", platform: "mac", arch: "arm64" }),
        expect.objectContaining({
          runner: "macos-26-intel",
          platform: "mac",
          arch: "x64",
        }),
      ]),
    );
    expect(commands).toMatch(/vp install --frozen-lockfile/);
    expect(commands).toMatch(/test:ui:build/);
    expect(commands).toMatch(/test:ui:desktop/);
    expect(commands).toMatch(/xvfb-run/);
    expect(commands).toMatch(/hdiutil attach/);
    expect(commands).toMatch(/hdiutil detach/);
    expect(commands).not.toMatch(/bundle\/macos.*\.app/);
    expect(commands).toMatch(/always\(\)/);
    expect(commands).toMatch(/actions\/upload-artifact/);
  });
});
