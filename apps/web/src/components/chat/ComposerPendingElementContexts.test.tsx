import type { ElementContextDraft } from "~/lib/elementContext";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ triggers: [] as React.ReactNode[] }));

vi.mock("~/lib/elementContext", () => ({
  formatElementContextLabel: (context: { label?: string }) => context.label ?? "Element",
  formatElementContextSourceLabel: (context: { source?: string | null }) => context.source ?? null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactNode }) => {
    harness.triggers.push(render);
    return <>{render}</>;
  },
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => <pre>{children}</pre>,
}));

import {
  ComposerPendingElementContextChip,
  ComposerPendingElementContexts,
} from "./ComposerPendingElementContexts";

beforeEach(() => {
  harness.triggers.length = 0;
});

function context(overrides: Record<string, unknown> = {}): ElementContextDraft {
  return {
    id: "context-1",
    label: "Hero heading",
    source: "Preview",
    pageUrl: "https://example.test/page",
    selector: "h1.hero",
    htmlPreview: "  <h1>Hero</h1>  ",
    ...overrides,
  } as unknown as ElementContextDraft;
}

function findButton(node: React.ReactNode): React.ReactElement | null {
  if (!isValidElement(node)) return null;
  if (node.type === "button") return node;
  const children = (node.props as { children?: React.ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}

describe("ComposerPendingElementContexts", () => {
  it("renders nothing for an empty list", () => {
    expect(
      renderToStaticMarkup(<ComposerPendingElementContexts contexts={[]} onRemove={vi.fn()} />),
    ).toBe("");
  });

  it("renders rich tooltip context and removes a chip", () => {
    const onRemove = vi.fn();
    const markup = renderToStaticMarkup(
      <ComposerPendingElementContexts
        contexts={[context()]}
        onRemove={onRemove}
        className="pending-contexts"
      />,
    );

    expect(markup).toContain("Hero heading");
    expect(markup).toContain("Preview");
    expect(markup).toContain("https://example.test/page");
    expect(markup).toContain("h1.hero");
    expect(markup).toContain("&lt;h1&gt;Hero&lt;/h1&gt;");
    const button = findButton(harness.triggers[0]);
    if (!button) throw new Error("Expected remove button");
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (
      button.props as {
        onClick: (clickEvent: { preventDefault: () => void; stopPropagation: () => void }) => void;
      }
    ).onClick(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith("context-1");
  });

  it("omits optional tooltip lines for minimal context", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingElementContextChip
        context={context({ source: null, pageUrl: null, selector: null, htmlPreview: " " })}
        onRemove={vi.fn()}
      />,
    );
    expect(markup).not.toContain("Preview");
    expect(markup).not.toContain("example.test");
  });
});
