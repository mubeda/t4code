import { EnvironmentId } from "@t4code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultAddProjectParent,
  joinProjectPath,
  shouldUseNativePicker,
  validateAddProjectPath,
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
