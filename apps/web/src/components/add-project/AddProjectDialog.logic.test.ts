import { EnvironmentId } from "@t4code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultAddProjectParent,
  joinProjectPath,
  shouldUseNativePicker,
  validateAddProjectPath,
  validateGitCloneParentPath,
  validateGitCloneUrl,
  validateProjectName,
  type AddProjectHostOption,
} from "./AddProjectDialog.logic";

const localHost: AddProjectHostOption = {
  environmentId: EnvironmentId.make("local"),
  label: "Local Mac",
  platform: "MacIntel",
  baseDirectory: "~/",
  isPrimary: true,
  desktopInstanceId: null,
  nativePickerAvailable: true,
};

describe("Add Project rules", () => {
  it("uses the environment base directory and falls back to home", () => {
    expect(defaultAddProjectParent(" ~/code ")).toBe("~/code/");
    expect(defaultAddProjectParent("")).toBe("~/");
  });

  it("accepts one directory name and rejects path-like names", () => {
    expect(validateProjectName(" demo ")).toBeNull();
    expect(validateProjectName("")).toBe("Enter a project name.");
    expect(validateProjectName(".")).toBe("Enter a project name other than . or ..");
    expect(validateProjectName("../demo")).toBe("Project names cannot contain path separators.");
    expect(validateProjectName("a\\b")).toBe("Project names cannot contain path separators.");
  });

  it("requires absolute or home-relative host paths", () => {
    expect(validateAddProjectPath("~/code", "Linux")).toBeNull();
    expect(validateAddProjectPath("/srv/code", "Linux")).toBeNull();
    expect(validateAddProjectPath("C:\\code", "Win32")).toBeNull();
    expect(validateAddProjectPath("./code", "Linux")).toBe(
      "Enter an absolute or home-relative path.",
    );
    expect(validateAddProjectPath("C:\\code", "Linux")).toBe(
      "Windows-style paths are only supported on Windows.",
    );
  });

  it("accepts common remote Git clone URL forms", () => {
    expect(validateGitCloneUrl("https://github.com/openai/codex.git")).toBeNull();
    expect(validateGitCloneUrl("http://git.example.com/team/project.git")).toBeNull();
    expect(validateGitCloneUrl("ssh://git@git.example.com/team/project.git")).toBeNull();
    expect(validateGitCloneUrl("git://git.example.com/team/project.git")).toBeNull();
    expect(validateGitCloneUrl("git@github.com:openai/codex.git")).toBeNull();
  });

  it("rejects whitespace, unsupported schemes, and arbitrary clone URL text", () => {
    expect(validateGitCloneUrl("")).toBe("Enter a Git repository URL.");
    expect(validateGitCloneUrl("not-a-url")).toBe("Enter a valid Git repository URL.");
    expect(validateGitCloneUrl("github.com/openai/codex")).toBe(
      "Enter a valid Git repository URL.",
    );
    expect(validateGitCloneUrl("https://github.com/openai/my repo.git")).toBe(
      "Enter a valid Git repository URL.",
    );
    expect(validateGitCloneUrl("file:///tmp/repository")).toBe("Enter a valid Git repository URL.");
  });

  it("accepts home-relative, POSIX, and Windows clone parent paths", () => {
    expect(validateGitCloneParentPath("~/projects")).toBeNull();
    expect(validateGitCloneParentPath("/srv/projects")).toBeNull();
    expect(validateGitCloneParentPath("C:\\projects")).toBeNull();
    expect(validateGitCloneParentPath("\\\\server\\projects")).toBeNull();
  });

  it("rejects empty and relative clone parent paths", () => {
    expect(validateGitCloneParentPath("")).toBe("Enter a clone parent folder.");
    expect(validateGitCloneParentPath("projects")).toBe("Enter an absolute or home-relative path.");
    expect(validateGitCloneParentPath("./projects")).toBe(
      "Enter an absolute or home-relative path.",
    );
  });

  it("joins target paths with the selected host separator", () => {
    expect(joinProjectPath("~/code/", "demo", "Linux")).toBe("~/code/demo");
    expect(joinProjectPath("C:\\code\\", "demo", "Win32")).toBe("C:\\code\\demo");
  });

  it("only uses a native picker for routable desktop hosts", () => {
    expect(shouldUseNativePicker(localHost)).toBe(true);
    expect(
      shouldUseNativePicker({
        ...localHost,
        environmentId: EnvironmentId.make("remote"),
        isPrimary: false,
        desktopInstanceId: null,
      }),
    ).toBe(false);
    expect(
      shouldUseNativePicker({
        ...localHost,
        environmentId: EnvironmentId.make("wsl"),
        isPrimary: false,
        desktopInstanceId: "wsl:Ubuntu",
      }),
    ).toBe(true);
  });
});
