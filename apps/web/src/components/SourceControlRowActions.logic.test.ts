import { MinusIcon, PlusIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { buildRowContextMenu, getRowActions, rowAreaOf } from "./SourceControlRowActions.logic";

describe("rowAreaOf", () => {
  it("keeps explicit staged/untracked and defaults everything else to unstaged", () => {
    expect(rowAreaOf("staged")).toBe("staged");
    expect(rowAreaOf("untracked")).toBe("untracked");
    expect(rowAreaOf(undefined)).toBe("unstaged");
  });
});

describe("getRowActions", () => {
  it("staged rows expose only Unstage", () => {
    const actions = getRowActions("staged");
    expect(actions.map((action) => action.kind)).toEqual(["unstage"]);
    expect(actions[0]!.label).toBe("Unstage");
    expect(actions[0]!.icon).toBe(MinusIcon);
  });

  it("unstaged rows expose Discard then Stage", () => {
    const actions = getRowActions("unstaged", "modified");
    expect(actions.map((action) => action.kind)).toEqual(["discard", "stage"]);
    expect(actions[0]!.label).toBe("Discard changes");
    expect(actions[0]!.icon).toBe(Undo2Icon);
    expect(actions[1]!.icon).toBe(PlusIcon);
  });

  it('labels the discard action "Restore file" for a deleted unstaged file', () => {
    const actions = getRowActions("unstaged", "deleted");
    expect(actions[0]!.kind).toBe("discard");
    expect(actions[0]!.label).toBe("Restore file");
  });

  it("untracked rows expose a destructive Delete then Stage", () => {
    const actions = getRowActions("untracked", "untracked");
    expect(actions.map((action) => action.kind)).toEqual(["delete", "stage"]);
    expect(actions[0]!.label).toBe("Delete untracked file");
    expect(actions[0]!.icon).toBe(Trash2Icon);
    expect(actions[0]!.destructive).toBe(true);
    expect(actions[1]!.kind).toBe("stage");
  });
});

describe("buildRowContextMenu", () => {
  it("is navigation-only and includes Open in External Editor in the primary env", () => {
    const model = buildRowContextMenu({ isPrimaryEnv: true });
    const ids = model.groups.flat().map((item) => item.id);
    expect(ids).toEqual(["view", "copy-path", "copy-relative-path", "open-external-editor"]);
    expect(ids).not.toContain("stage");
    expect(ids).not.toContain("discard");
    expect(ids).not.toContain("delete");
  });

  it("omits Open in External Editor outside the primary env", () => {
    const model = buildRowContextMenu({ isPrimaryEnv: false });
    const ids = model.groups.flat().map((item) => item.id);
    expect(ids).toEqual(["view", "copy-path", "copy-relative-path"]);
  });
});
