export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function hostPathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}

function isAbsoluteHostPath(value: string): boolean {
  if (isUncPath(value)) return hostPathSegments(value).length >= 2;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return value.startsWith("/");
}

function isUnsafeRelativeHostPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:/.test(value) ||
    value.split(/[\\/]+/).includes("..")
  );
}

export function joinHostPath(base: string, relativePath: string): string {
  if (!isAbsoluteHostPath(base)) return base;

  const separator: "/" | "\\" = isWindowsAbsolutePath(base) || base.includes("\\") ? "\\" : "/";

  let normalizedBase: string;
  if (isWindowsDrivePath(base)) {
    const drive = base.slice(0, 2);
    const baseSegments = hostPathSegments(base.slice(2));
    normalizedBase =
      baseSegments.length === 0 ? `${drive}\\` : `${drive}\\${baseSegments.join("\\")}`;
  } else if (isUncPath(base)) {
    const baseSegments = hostPathSegments(base);
    normalizedBase = `\\\\${baseSegments.join("\\")}`;
    if (baseSegments.length <= 2) normalizedBase += "\\";
  } else {
    const baseSegments = hostPathSegments(base);
    const hasRoot = base.startsWith("/") || base.startsWith("\\");
    normalizedBase = `${hasRoot ? separator : ""}${baseSegments.join(separator)}`;
  }

  if (isUnsafeRelativeHostPath(relativePath)) return normalizedBase;

  const relativeSegments = hostPathSegments(relativePath);
  if (relativeSegments.length === 0) return normalizedBase;

  const normalizedRelative = relativeSegments.join(separator);
  if (normalizedBase.length === 0) return normalizedRelative;
  if (normalizedBase.endsWith(separator)) return `${normalizedBase}${normalizedRelative}`;
  return `${normalizedBase}${separator}${normalizedRelative}`;
}
