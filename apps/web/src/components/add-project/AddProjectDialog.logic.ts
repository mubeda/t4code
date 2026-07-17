import type { EnvironmentId } from "@t4code/contracts";
import { isWindowsAbsolutePath } from "@t4code/shared/path";

import {
  ensureBrowseDirectoryPath,
  isUnsupportedWindowsProjectPath,
  normalizeProjectPathForDispatch,
} from "~/lib/projectPaths";

export type AddProjectStep = "start" | "host-path" | "clone" | "create";

export interface AddProjectHostOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platform: string;
  readonly baseDirectory: string;
  readonly isPrimary: boolean;
  readonly desktopInstanceId: string | null;
  readonly nativePickerAvailable: boolean;
}

export function defaultAddProjectParent(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return ensureBrowseDirectoryPath(trimmed.length === 0 ? "~/" : trimmed);
}

export function validateProjectName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) return "Enter a project name.";
  if (name === "." || name === "..") return "Enter a project name other than . or ..";
  if (name.includes("/") || name.includes("\\")) {
    return "Project names cannot contain path separators.";
  }
  return null;
}

export function validateAddProjectPath(value: string, platform: string): string | null {
  const path = value.trim();
  if (path.length === 0) return "Enter a project path.";
  if (isUnsupportedWindowsProjectPath(path, platform)) {
    return "Windows-style paths are only supported on Windows.";
  }
  if (
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\") ||
    path.startsWith("/") ||
    isWindowsAbsolutePath(path)
  ) {
    return null;
  }
  return "Enter an absolute or home-relative path.";
}

const supportedGitCloneProtocols = new Set(["http:", "https:", "ssh:", "git:"]);
const scpStyleGitCloneUrlPattern = /^[^@\s/:]+@[^:\s/]+:[^\s]+$/;

export function validateGitCloneUrl(value: string): string | null {
  const url = value.trim();
  if (url.length === 0) return "Enter a Git repository URL.";
  if (url !== value || /\s/.test(url)) return "Enter a valid Git repository URL.";
  if (scpStyleGitCloneUrlPattern.test(url)) return null;

  try {
    const parsed = new URL(url);
    if (
      supportedGitCloneProtocols.has(parsed.protocol) &&
      parsed.hostname.length > 0 &&
      parsed.pathname.length > 1
    ) {
      return null;
    }
  } catch {
    // The shared validation result below covers malformed URLs.
  }
  return "Enter a valid Git repository URL.";
}

export function validateGitCloneParentPath(value: string): string | null {
  const path = value.trim();
  if (path.length === 0) return "Enter a clone parent folder.";
  if (
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\") ||
    path.startsWith("/") ||
    isWindowsAbsolutePath(path)
  ) {
    return null;
  }
  return "Enter an absolute or home-relative path.";
}

export function joinProjectPath(parent: string, name: string, platform: string): string {
  const normalizedParent = normalizeProjectPathForDispatch(parent);
  const separator = /^win(dows|32)?/i.test(platform) ? "\\" : "/";
  return `${normalizedParent}${normalizedParent.endsWith(separator) ? "" : separator}${name.trim()}`;
}

export function shouldUseNativePicker(host: AddProjectHostOption): boolean {
  return host.nativePickerAvailable && (host.isPrimary || host.desktopInstanceId !== null);
}
