import { describe, expect, it } from "vite-plus/test";

import {
  buildFileTreeMenuModel,
  detectPathSeparator,
  entryName,
  type BuildFileTreeMenuModelInput,
  type FileTreeMenuItem,
  type FileTreeMenuItemId,
  joinRelativePath,
  joinWorkspacePath,
  parentRelativePath,
  stripTrailingSlash,
} from "./FileTreeContextMenu.logic";

const BASE: BuildFileTreeMenuModelInput = {
  entryKind: "file",
  isPreviewable: false,
  isMarkdown: false,
  isPrimaryEnv: false,
  hasWorkspaceRoot: true,
};

function flatten(input: BuildFileTreeMenuModelInput): FileTreeMenuItem[] {
  return buildFileTreeMenuModel(input).groups.flat();
}

function ids(input: BuildFileTreeMenuModelInput): FileTreeMenuItemId[] {
  return flatten(input).map((item) => item.id);
}

function find(
  input: BuildFileTreeMenuModelInput,
  id: FileTreeMenuItemId,
): FileTreeMenuItem | undefined {
  return flatten(input).find((item) => item.id === id);
}

describe("buildFileTreeMenuModel — file rows", () => {
  it("orders groups create / actions / mutate", () => {
    const groupIds = buildFileTreeMenuModel({
      ...BASE,
      isPrimaryEnv: true,
      isPreviewable: true,
    }).groups.map((group) => group.map((item) => item.id));
    expect(groupIds).toEqual([
      ["new-file", "new-folder"],
      ["copy-path", "copy-relative-path", "duplicate", "open-external-editor", "open-preview"],
      ["rename", "delete"],
    ]);
  });

  it("marks mutation items enabled and delete destructive", () => {
    expect(find(BASE, "new-file")?.enabled).toBe(true);
    expect(find(BASE, "new-folder")?.enabled).toBe(true);
    expect(find(BASE, "rename")?.enabled).toBe(true);
    expect(find(BASE, "duplicate")?.enabled).toBe(true);
    const del = find(BASE, "delete");
    expect(del?.enabled).toBe(true);
    expect(del?.destructive).toBe(true);
  });

  it("shows Duplicate for files but never Add as Project", () => {
    expect(ids(BASE)).toContain("duplicate");
    expect(ids(BASE)).not.toContain("add-as-project");
  });

  it("offers external editor only on the primary environment", () => {
    expect(ids({ ...BASE, isPrimaryEnv: false })).not.toContain("open-external-editor");
    expect(ids({ ...BASE, isPrimaryEnv: true })).toContain("open-external-editor");
  });

  it("offers preview only for previewable files", () => {
    expect(ids({ ...BASE, isPreviewable: false })).not.toContain("open-preview");
    expect(find({ ...BASE, isPreviewable: true }, "open-preview")?.enabled).toBe(true);
  });
});

describe("buildFileTreeMenuModel — directory rows", () => {
  const DIR: BuildFileTreeMenuModelInput = { ...BASE, entryKind: "directory" };

  it("shows Add as Project but not Duplicate / editor / preview", () => {
    const list = ids({ ...DIR, isPrimaryEnv: true, isPreviewable: true });
    expect(list).toContain("add-as-project");
    expect(list).not.toContain("duplicate");
    expect(list).not.toContain("open-external-editor");
    expect(list).not.toContain("open-preview");
  });

  it("keeps rename and delete in the final group", () => {
    const groups = buildFileTreeMenuModel(DIR).groups;
    expect(groups.at(-1)?.map((i) => i.id)).toEqual(["rename", "delete"]);
  });
});

describe("buildFileTreeMenuModel — background", () => {
  const BG: BuildFileTreeMenuModelInput = { ...BASE, entryKind: "background" };

  it("offers enabled create items plus Copy Path and Refresh, no rename/delete", () => {
    const list = ids(BG);
    expect(list).toEqual(["new-file", "new-folder", "copy-path", "refresh"]);
    expect(find(BG, "new-file")?.enabled).toBe(true);
    expect(find(BG, "refresh")?.enabled).toBe(true);
  });
});

describe("parentRelativePath / entryName / joinRelativePath", () => {
  it("splits a nested path into parent directory and name", () => {
    expect(parentRelativePath("src/utils/index.ts")).toBe("src/utils");
    expect(entryName("src/utils/index.ts")).toBe("index.ts");
  });

  it("treats a top-level entry as having an empty parent", () => {
    expect(parentRelativePath("README.md")).toBe("");
    expect(entryName("README.md")).toBe("README.md");
  });

  it("strips a directory trailing slash before splitting", () => {
    expect(parentRelativePath("src/utils/")).toBe("src");
    expect(entryName("src/utils/")).toBe("utils");
  });

  it("joins a parent directory and a child name, omitting the slash at the root", () => {
    expect(joinRelativePath("src/utils", "new.ts")).toBe("src/utils/new.ts");
    expect(joinRelativePath("", "new.ts")).toBe("new.ts");
  });
});

describe("buildFileTreeMenuModel — workspace root gating", () => {
  it("disables Copy Path (absolute) without a workspace root", () => {
    expect(find({ ...BASE, hasWorkspaceRoot: false }, "copy-path")?.enabled).toBe(false);
    expect(find({ ...BASE, hasWorkspaceRoot: true }, "copy-path")?.enabled).toBe(true);
  });

  it("keeps Copy Relative Path enabled regardless of workspace root", () => {
    expect(find({ ...BASE, hasWorkspaceRoot: false }, "copy-relative-path")?.enabled).toBe(true);
  });

  it("disables Add as Project without a workspace root", () => {
    const dir: BuildFileTreeMenuModelInput = { ...BASE, entryKind: "directory" };
    expect(find({ ...dir, hasWorkspaceRoot: false }, "add-as-project")?.enabled).toBe(false);
    expect(find({ ...dir, hasWorkspaceRoot: true }, "add-as-project")?.enabled).toBe(true);
  });
});

describe("stripTrailingSlash", () => {
  it("strips a Pierre directory trailing slash", () => {
    expect(stripTrailingSlash("src/")).toBe("src");
    expect(stripTrailingSlash("src/utils/")).toBe("src/utils");
  });

  it("leaves files and empty strings untouched", () => {
    expect(stripTrailingSlash("file.ts")).toBe("file.ts");
    expect(stripTrailingSlash("")).toBe("");
  });
});

describe("detectPathSeparator", () => {
  it("uses backslash for Windows roots and forward slash otherwise", () => {
    expect(detectPathSeparator("X:\\Workspaces\\Orca")).toBe("\\");
    expect(detectPathSeparator("/home/user/proj")).toBe("/");
  });
});

describe("joinWorkspacePath", () => {
  it("joins Windows roots with backslashes even when the relative path uses slashes", () => {
    expect(joinWorkspacePath("X:\\Workspaces\\Orca", "src/utils")).toBe(
      "X:\\Workspaces\\Orca\\src\\utils",
    );
  });

  it("joins POSIX roots with forward slashes", () => {
    expect(joinWorkspacePath("/home/user/proj", "src/utils")).toBe("/home/user/proj/src/utils");
  });

  it("handles directory trailing slashes and trailing root separators", () => {
    expect(joinWorkspacePath("/home/user/proj/", "src/utils/")).toBe("/home/user/proj/src/utils");
    expect(joinWorkspacePath("X:\\Workspaces\\Orca\\", "src\\utils")).toBe(
      "X:\\Workspaces\\Orca\\src\\utils",
    );
  });

  it("returns the root itself for an empty or dot relative path", () => {
    expect(joinWorkspacePath("/home/user/proj", "")).toBe("/home/user/proj");
    expect(joinWorkspacePath("/home/user/proj", ".")).toBe("/home/user/proj");
  });
});
