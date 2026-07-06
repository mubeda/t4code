import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SourceControlChangesList } from "./SourceControlChangesList";
import type { WorkingTreeFile } from "./SourceControlPanel.logic";

const FILES: WorkingTreeFile[] = [
  { path: "docs/prps/PFS-1848/master-plan.md", insertions: 218, deletions: 0 },
  { path: "tasks.md", insertions: 139, deletions: 4 },
];

const STAGED_FILE: WorkingTreeFile = {
  path: "src/app.ts",
  insertions: 3,
  deletions: 1,
  status: "modified",
  area: "staged",
};
const UNSTAGED_FILE: WorkingTreeFile = {
  path: "src/util.ts",
  insertions: 2,
  deletions: 0,
  status: "modified",
};
const DELETED_FILE: WorkingTreeFile = {
  path: "src/old.ts",
  insertions: 0,
  deletions: 9,
  status: "deleted",
};
const UNTRACKED_FILE: WorkingTreeFile = {
  path: "src/new.ts",
  insertions: 5,
  deletions: 0,
  status: "untracked",
  area: "untracked",
};

describe("SourceControlChangesList", () => {
  it("renders each file's name, directory hint and +/- counts", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList files={FILES} onToggle={() => {}} onOpenFile={() => {}} />,
    );
    expect(markup).toContain("master-plan.md");
    expect(markup).toContain("docs/prps/PFS-1848");
    expect(markup).toContain("+218");
    expect(markup).toContain("-4");
  });

  it("renders the injected badge slot", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={FILES}
        onToggle={() => {}}
        onOpenFile={() => {}}
        renderBadge={(file) => (
          <span data-testid="badge">{file.path === "tasks.md" ? "U" : "M"}</span>
        )}
      />,
    );
    expect(markup).toContain('data-testid="badge"');
  });

  it("renders an empty state when there are no files", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList files={[]} onToggle={() => {}} onOpenFile={() => {}} />,
    );
    expect(markup).toContain("No changes");
  });

  it("renders no checkbox when `checked` is omitted (legacy server)", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList files={FILES} onToggle={() => {}} onOpenFile={() => {}} />,
    );
    expect(markup).not.toContain('data-slot="checkbox"');
  });

  it('renders a checked box labeled "Unstage <path>" for a staged file', () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={FILES}
        checked={() => true}
        onToggle={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect(markup).toContain('data-slot="checkbox"');
    expect(markup).toContain(`aria-label="Unstage ${FILES[0]!.path}"`);
    expect(markup).toContain('data-checked=""');
  });

  it('renders an unchecked box labeled "Stage <path>" for an unstaged file', () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={FILES}
        checked={() => false}
        onToggle={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect(markup).toContain('data-slot="checkbox"');
    expect(markup).toContain(`aria-label="Stage ${FILES[0]!.path}"`);
    expect(markup).toContain('data-unchecked=""');
  });

  it("renders no inline action buttons when no row-action handlers are wired", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList files={[STAGED_FILE]} onToggle={() => {}} onOpenFile={() => {}} />,
    );
    expect(markup).not.toContain(`aria-label="Unstage ${STAGED_FILE.path}"`);
  });

  it("renders a single Unstage inline action for a staged row", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={[STAGED_FILE]}
        onToggle={() => {}}
        onOpenFile={() => {}}
        onUnstageFile={() => {}}
        onStageFile={() => {}}
      />,
    );
    expect(markup).toContain(`aria-label="Unstage ${STAGED_FILE.path}"`);
    expect(markup).not.toContain(`aria-label="Stage ${STAGED_FILE.path}"`);
  });

  it("renders Discard then Stage inline actions for an unstaged row", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={[UNSTAGED_FILE]}
        onToggle={() => {}}
        onOpenFile={() => {}}
        onRequestDiscardFile={() => {}}
        onStageFile={() => {}}
      />,
    );
    expect(markup).toContain(`aria-label="Discard changes ${UNSTAGED_FILE.path}"`);
    expect(markup).toContain(`aria-label="Stage ${UNSTAGED_FILE.path}"`);
  });

  it('labels the discard action "Restore file" for a deleted unstaged row', () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={[DELETED_FILE]}
        onToggle={() => {}}
        onOpenFile={() => {}}
        onRequestDiscardFile={() => {}}
      />,
    );
    expect(markup).toContain(`aria-label="Restore file ${DELETED_FILE.path}"`);
  });

  it("renders a destructive Delete inline action for an untracked row", () => {
    const markup = renderToStaticMarkup(
      <SourceControlChangesList
        files={[UNTRACKED_FILE]}
        onToggle={() => {}}
        onOpenFile={() => {}}
        onRequestDiscardFile={() => {}}
        onStageFile={() => {}}
      />,
    );
    expect(markup).toContain(`aria-label="Delete untracked file ${UNTRACKED_FILE.path}"`);
    expect(markup).toContain(`aria-label="Stage ${UNTRACKED_FILE.path}"`);
    expect(markup).toContain("text-destructive");
  });
});
