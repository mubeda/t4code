import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CLIENT_SETTINGS } from "@t4code/contracts/settings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { vi } from "vite-plus/test";
import { __setClientSettingsForTests } from "../hooks/useSettings";

let ChatMarkdownComponent: typeof import("./ChatMarkdown").default | null = null;
let domWindow: Window | null = null;

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];

beforeEach(async () => {
  domWindow = new Window({ url: "https://t4code.test/" });
  vi.stubGlobal("window", domWindow);
  vi.stubGlobal("document", domWindow.document);
  vi.stubGlobal("navigator", domWindow.navigator);
  vi.stubGlobal("localStorage", domWindow.localStorage);
  vi.stubGlobal("Node", domWindow.Node);
  vi.stubGlobal("Element", domWindow.Element);
  vi.stubGlobal("HTMLElement", domWindow.HTMLElement);
  vi.stubGlobal("HTMLInputElement", domWindow.HTMLInputElement);
  vi.stubGlobal("HTMLButtonElement", domWindow.HTMLButtonElement);
  vi.stubGlobal("Event", domWindow.Event);
  vi.stubGlobal("MouseEvent", domWindow.MouseEvent);
  vi.stubGlobal("KeyboardEvent", domWindow.KeyboardEvent);
  vi.stubGlobal("PointerEvent", domWindow.PointerEvent);
  vi.stubGlobal("CustomEvent", domWindow.CustomEvent);
  vi.stubGlobal("customElements", domWindow.customElements);
  vi.stubGlobal("DOMParser", domWindow.DOMParser);
  vi.stubGlobal("MutationObserver", domWindow.MutationObserver);
  vi.stubGlobal("ResizeObserver", domWindow.ResizeObserver);
  vi.stubGlobal("getComputedStyle", domWindow.getComputedStyle.bind(domWindow));
  vi.stubGlobal("requestAnimationFrame", domWindow.requestAnimationFrame.bind(domWindow));
  vi.stubGlobal("cancelAnimationFrame", domWindow.cancelAnimationFrame.bind(domWindow));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(domWindow.HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  ChatMarkdownComponent ??= (await import("./ChatMarkdown")).default;
}, 30_000);

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  vi.restoreAllMocks();
  domWindow?.close();
  domWindow = null;
  vi.unstubAllGlobals();
});

interface RenderOptions {
  cwd?: string | undefined;
  onTaskListChange?: (input: { markerOffset: number; checked: boolean }) => void;
  isStreaming?: boolean;
  skills?: ReadonlyArray<{ name: string; displayName: string }>;
  className?: string;
  lineBreaks?: boolean;
}

async function renderMarkdown(text: string, options: RenderOptions = {}) {
  const ChatMarkdown = ChatMarkdownComponent ?? (await import("./ChatMarkdown")).default;
  return renderToStaticMarkup(<ChatMarkdown text={text} cwd={options.cwd} {...options} />);
}

async function mountMarkdown(text: string, options: RenderOptions = {}): Promise<HTMLDivElement> {
  const ChatMarkdown = ChatMarkdownComponent ?? (await import("./ChatMarkdown")).default;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedTrees.push({ container, root });
  await act(async () => root.render(<ChatMarkdown text={text} cwd={options.cwd} {...options} />));
  return container;
}

function installClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

/**
 * Code fences render a plain <pre> fallback until the shared shiki highlighter
 * promise resolves; once it does, re-rendering emits highlighted markup
 * synchronously. Poll re-renders until the highlighted path is taken so the
 * assertion does not depend on module-level promise timing.
 */
async function renderMarkdownUntilHighlighted(text: string, options: RenderOptions = {}) {
  let markup = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    markup = await renderMarkdown(text, options);
    if (markup.includes("chat-markdown-shiki")) {
      return markup;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`highlighter never resolved; last markup: ${markup}`);
}

describe("ChatMarkdown", () => {
  describe("basic markdown", () => {
    it("renders paragraphs with inline emphasis inside the chat-markdown wrapper", async () => {
      const markup = await renderMarkdown("Hello **world** and *stars*");

      expect(markup).toContain("chat-markdown");
      expect(markup).toContain("<strong>world</strong>");
      expect(markup).toContain("<em>stars</em>");
    });

    it("applies the optional className to the wrapper", async () => {
      const markup = await renderMarkdown("Body", { className: "custom-markdown-class" });

      expect(markup).toContain("custom-markdown-class");
    });

    it("treats single newlines as hard breaks only when lineBreaks is set", async () => {
      const withBreaks = await renderMarkdown("first line\nsecond line", { lineBreaks: true });
      const withoutBreaks = await renderMarkdown("first line\nsecond line");

      expect(withBreaks).toContain("<br/>");
      expect(withoutBreaks).not.toContain("<br/>");
    });

    it("replaces known $skill tokens with skill chips in paragraphs and list items", async () => {
      const markup = await renderMarkdown("Use $review then $unknown\n\n- try $review here", {
        skills: [{ name: "review", displayName: "Review" }],
      });

      expect(markup).toContain('data-markdown-copy="$review"');
      expect(markup).toContain("Review");
      // Unknown skills stay as raw text.
      expect(markup).toContain("$unknown");
      expect(markup).not.toContain('data-markdown-copy="$unknown"');
    });
  });

  describe("task lists", () => {
    it("renders interactive checkboxes with marker offsets when onTaskListChange is provided", async () => {
      const text = "- [ ] alpha\n- [x] beta\n- plain item";
      const markup = await renderMarkdown(text, { onTaskListChange: () => {} });

      expect(markup).toContain('name="markdown-task"');
      expect(markup).toContain('aria-label="Toggle task"');
      expect(markup).toContain('data-task-marker-offset="2"');
      expect(markup).toContain('data-task-marker-offset="14"');
      // The plain list item carries no marker offset.
      expect(markup).toContain("plain item");
    });

    it("renders read-only checkboxes without a task list handler", async () => {
      const markup = await renderMarkdown("- [ ] alpha\n- [x] beta");

      expect(markup).not.toContain('name="markdown-task"');
      expect(markup).toContain('type="checkbox"');
    });

    it("computes marker offsets for ordered task lists", async () => {
      const markup = await renderMarkdown("1. [ ] first", { onTaskListChange: () => {} });

      expect(markup).toContain('data-task-marker-offset="3"');
    });

    it("recognizes every supported list marker and ignores ordinary list items", async () => {
      const text = ["+ [X] plus", "* [ ] star", "2) [x] ordered", "- ordinary"].join("\n");
      const markup = await renderMarkdown(text, { onTaskListChange: () => {} });

      expect(markup).toContain('data-task-marker-offset="2"');
      expect(markup).toContain('data-task-marker-offset="13"');
      expect(markup).toContain('data-task-marker-offset="25"');
      expect(markup).toContain("ordinary");
    });

    it("reports the attached task marker when the rendered checkbox changes", async () => {
      const onTaskListChange = vi.fn();
      const container = await mountMarkdown("- [ ] alpha", { onTaskListChange });
      const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Toggle task"]');
      expect(checkbox).not.toBeNull();

      await click(checkbox!);

      expect(onTaskListChange).toHaveBeenCalledOnce();
      expect(onTaskListChange).toHaveBeenCalledWith({ markerOffset: 2, checked: true });
    });
  });

  describe("links", () => {
    it("renders external http links with favicon, breakable text and new-tab attributes", async () => {
      const markup = await renderMarkdown(
        "See [https://example.com/docs](https://example.com/docs)",
      );

      expect(markup).toContain("chat-markdown-link-favicon");
      expect(markup).toContain("www.google.com/s2/favicons?domain=example.com");
      expect(markup).toContain('target="_blank"');
      expect(markup).toContain('rel="noopener noreferrer"');
      expect(markup).toContain("<wbr/>");
      expect(markup).toContain("chat-markdown-link-leading");
    });

    it("renders external links with a leading string child when markup children are mixed", async () => {
      const markup = await renderMarkdown("[Example **docs**](https://example.com)");

      expect(markup).toContain("chat-markdown-link-favicon");
      expect(markup).toContain("<strong>docs</strong>");
    });

    it("renders external links whose first child is an element", async () => {
      const markup = await renderMarkdown("[**Bold** link](https://example.com)");

      expect(markup).toContain("chat-markdown-link-favicon");
      expect(markup).toContain("<strong>Bold</strong>");
    });

    it("renders non-http scheme links without favicon treatment", async () => {
      const markup = await renderMarkdown("[mail me](mailto:hi@example.com)");

      expect(markup).toContain('href="mailto:hi@example.com"');
      expect(markup).not.toContain("chat-markdown-link-favicon");
    });

    it("renders same-document fragment links without new-tab attributes", async () => {
      const markup = await renderMarkdown("[jump](#section)");

      expect(markup).toContain('href="#section"');
      expect(markup).not.toContain('target="_blank"');
      expect(markup).not.toContain("chat-markdown-link-favicon");
    });

    it("renders absolute file paths with line/column as file chips", async () => {
      const markup = await renderMarkdown("Open [main](/Users/me/project/src/main.ts:12:5) now");

      expect(markup).toContain("chat-markdown-file-link");
      expect(markup).toContain("main.ts · L12:C5");
      expect(markup).toContain(
        'data-markdown-copy="[main.ts](/Users/me/project/src/main.ts:12:5)"',
      );
    });

    it("disambiguates duplicate basenames with parent directory suffixes", async () => {
      const markup = await renderMarkdown(
        "[a](/Users/me/alpha/utils/index.ts) and [b](/Users/me/beta/utils/index.ts)",
      );

      expect(markup).toContain("index.ts · alpha/utils");
      expect(markup).toContain("index.ts · beta/utils");
    });

    it("rewrites file:// links to plain paths and renders them as file chips", async () => {
      const markup = await renderMarkdown("[readme](file:///Users/me/project/README.md)");

      expect(markup).toContain("chat-markdown-file-link");
      expect(markup).toContain("README.md");
      expect(markup).toContain('href="/Users/me/project/README.md"');
    });

    it("resolves relative file links against cwd", async () => {
      const markup = await renderMarkdown("[helper](src/utils/helpers.ts)", {
        cwd: "/Users/me/project",
      });

      expect(markup).toContain("chat-markdown-file-link");
      expect(markup).toContain("helpers.ts");
    });

    it("does not treat relative paths as file links without a cwd", async () => {
      const markup = await renderMarkdown("[helper](src/utils/helpers.ts)");

      expect(markup).not.toContain("chat-markdown-file-link");
    });

    it("renders heading links with non-protocol plain text using a single leading character", async () => {
      // Headings do not run the skill-chip transform, so the link sees plain
      // string children and plainHastText returns the label.
      const markup = await renderMarkdown("# [Example docs](https://example.com)");

      expect(markup).toContain("chat-markdown-link-favicon");
      expect(markup).toContain("chat-markdown-link-leading");
      expect(markup).toContain("<wbr/>");
    });

    it("renders heading links with a leading string child followed by markup", async () => {
      const markup = await renderMarkdown("# [Example **docs**](https://example.com)");

      expect(markup).toContain("chat-markdown-link-favicon");
      expect(markup).toContain("<strong>docs</strong>");
    });

    it("renders links with empty labels through the element branch", async () => {
      const markup = await renderMarkdown("[](https://example.com)");

      expect(markup).toContain("chat-markdown-link-favicon");
    });

    it("preserves protocol-relative links and sanitizes unsupported destinations", async () => {
      const markup = await renderMarkdown(
        [
          "[protocol relative](//example.com/path)",
          "[uppercase](HTTPS://EXAMPLE.COM/UP)",
          "[telephone](tel:+123456)",
          "[invalid](https://[invalid)",
        ].join("\n\n"),
      );

      expect(markup).toContain('href="//example.com/path"');
      expect(markup).not.toContain('href="HTTPS://EXAMPLE.COM/UP"');
      expect(markup).not.toContain('href="tel:+123456"');
      expect(markup).not.toContain("domain=%5Binvalid");
    });

    it("computes deeper suffixes and preserves line-only file references", async () => {
      const markup = await renderMarkdown(
        [
          "[first](/repo/alpha/common/src/index.ts:7)",
          "[second](/repo/beta/common/src/index.ts:9)",
          "[again](/repo/alpha/common/src/index.ts:7)",
          "[windows](/C:/repo/src/main.ts:12)",
        ].join(" and "),
      );

      expect(markup).toContain("index.ts · alpha/common/src · L7");
      expect(markup).toContain("index.ts · beta/common/src · L9");
      expect(markup).toContain("main.ts · L12");
      expect(markup).not.toContain(":C");
    });

    it("keeps repeated identical basenames concise", async () => {
      const markup = await renderMarkdown(
        "[one](/repo/src/repeated.ts) and [two](/repo/src/repeated.ts)",
      );

      expect(markup).toContain("repeated.ts");
      expect(markup).not.toContain("repeated.ts · repo/src");
    });

    it("records favicon failures and uses the session fallback on the next render", async () => {
      const text = "[Example](https://fallback.example/path)";
      const container = await mountMarkdown(text);
      const image = container.querySelector<HTMLImageElement>(
        'img[src*="domain=fallback.example"]',
      );
      expect(image).not.toBeNull();

      await act(async () => image!.dispatchEvent(new Event("error", { bubbles: true })));
      const second = await renderMarkdown(text);

      expect(second).toContain("lucide-globe");
      expect(second).not.toContain("domain=fallback.example");
    });
  });

  describe("tables", () => {
    it("renders markdown tables inside the interactive table container", async () => {
      const markup = await renderMarkdown(
        ["| Name | Value |", "| ---- | ----- |", "| alpha | 1 |"].join("\n"),
      );

      expect(markup).toContain("chat-markdown-table-container");
      // wordWrap defaults to true, so tables start expanded.
      expect(markup).toContain('data-expanded="true"');
      expect(markup).toContain("<table");
      expect(markup).toContain("alpha");
      expect(markup).toContain('aria-label="Collapse table cells"');
      expect(markup).toContain('aria-label="Copy table"');
    });

    it("starts tables collapsed when line wrapping is disabled", async () => {
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: false });

      const markup = await renderMarkdown(
        ["| Name | Value |", "| ---- | ----- |", "| alpha | 1 |"].join("\n"),
      );

      expect(markup).toContain('data-expanded="false"');
      expect(markup).toContain('aria-label="Expand table cells"');
    });

    it("updates table expansion through the attached table control", async () => {
      const container = await mountMarkdown(["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n"));
      const tableContainer = container.querySelector<HTMLElement>(".chat-markdown-table-container");
      const toggle = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse table cells"]',
      );
      expect(tableContainer).not.toBeNull();
      expect(toggle).not.toBeNull();

      await click(toggle!);
      expect(tableContainer?.dataset.expanded).toBe("false");
      expect(container.querySelector('button[aria-label="Expand table cells"]')).not.toBeNull();
    });
  });

  describe("details", () => {
    it("renders closed details blocks with the summary as trigger", async () => {
      const markup = await renderMarkdown(
        [
          "<details>",
          "<summary>Extra notes</summary>",
          "",
          "Hidden body text",
          "",
          "</details>",
        ].join("\n"),
      );

      expect(markup).toContain('data-markdown-details=""');
      expect(markup).toContain('data-markdown-details-open="false"');
      expect(markup).toContain("Extra notes");
    });

    it("renders open details blocks with their content visible", async () => {
      const markup = await renderMarkdown(
        [
          "<details open>",
          "<summary>Extra notes</summary>",
          "",
          "Visible body text",
          "",
          "</details>",
        ].join("\n"),
      );

      expect(markup).toContain('data-markdown-details-open="true"');
      expect(markup).toContain("Visible body text");
    });

    it("falls back to a generic summary when none is present", async () => {
      const markup = await renderMarkdown(
        ["<details>", "", "body only", "", "</details>"].join("\n"),
      );

      expect(markup).toContain(">Details</span>");
    });

    it("falls back to the generic label for an empty summary", async () => {
      const markup = await renderMarkdown(
        ["<details open>", "<summary></summary>", "", "body", "", "</details>"].join("\n"),
      );

      expect(markup).toContain(">Details</span>");
      expect(markup).toContain("body");
    });
  });

  describe("code blocks", () => {
    it("renders fenced code with language, fence title and action chrome", async () => {
      const markup = await renderMarkdown(
        ['```ts title="example.ts"', "const x: number = 1;", "```"].join("\n"),
      );

      expect(markup).toContain("chat-markdown-codeblock");
      expect(markup).toContain('data-language="ts"');
      // wordWrap defaults to true, so code blocks start wrapped.
      expect(markup).toContain('data-wrap="true"');
      expect(markup).toContain("example.ts");
      // Token-level assertion: shiki may already have highlighted the code
      // into per-token spans depending on when the shared highlighter loads.
      expect(markup).toContain("const");
      expect(markup).toContain("number");
      expect(markup).toContain('aria-label="Disable line wrap"');
      expect(markup).toContain('aria-label="Copy code"');
    });

    it("extracts bare filename tokens from fence meta", async () => {
      const markup = await renderMarkdown(
        ["```js scripts/build.js", "console.log(1);", "```"].join("\n"),
      );

      expect(markup).toContain('data-language="js"');
      expect(markup).toContain("scripts/build.js");
    });

    it("extracts quoted and unquoted title aliases while ignoring non-file tokens", async () => {
      const singleQuoted = await renderMarkdown(
        ["```ts file='src/single.ts'", "const single = true;", "```"].join("\n"),
      );
      const unquoted = await renderMarkdown(
        ["```ts filename=src/plain.ts", "const plain = true;", "```"].join("\n"),
      );
      const ignored = await renderMarkdown(
        ["```ts not-a-file-token", "const ignored = true;", "```"].join("\n"),
      );

      expect(singleQuoted).toContain("src/single.ts");
      expect(unquoted).toContain("src/plain.ts");
      expect(ignored).toContain('aria-label="Language: ts"');
      expect(ignored).not.toContain("not-a-file-token</span>");
    });

    it("maps gitignore fences to the ini grammar", async () => {
      const markup = await renderMarkdown(["```gitignore", "node_modules/", "```"].join("\n"));

      expect(markup).toContain('data-language="ini"');
    });

    it("falls back to a text label for languages without a specific icon", async () => {
      const markup = await renderMarkdown(["```someunknownlanguage", "abc", "```"].join("\n"));

      expect(markup).toContain('data-language="someunknownlanguage"');
      expect(markup).toContain(">someunknownlanguage</span>");
    });

    it("shows an icon-only title with language tooltip for known languages", async () => {
      const markup = await renderMarkdown(["```ts", "const a = 1;", "```"].join("\n"));

      expect(markup).toContain('aria-label="Language: ts"');
    });

    it("renders fences without a language as plain text blocks", async () => {
      const markup = await renderMarkdown(["```", "no language here", "```"].join("\n"));

      expect(markup).toContain('data-language="text"');
      expect(markup).toContain("no language here");
    });

    it("starts code blocks unwrapped when line wrapping is disabled", async () => {
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: false });

      const markup = await renderMarkdown(["```ts", "const longLine = true;", "```"].join("\n"));

      expect(markup).toContain('data-wrap="false"');
      expect(markup).toContain('aria-label="Wrap lines"');
    });

    it("rerenders wrapping state and copies rendered code through the clipboard", async () => {
      const writeText = vi.fn(async () => {});
      installClipboard(writeText);
      const container = await mountMarkdown(["```ts", "const value = 1;", "```"].join("\n"));
      const codeBlock = container.querySelector<HTMLElement>(".chat-markdown-codeblock");
      const wrap = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Disable line wrap"]',
      );
      const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
      expect(codeBlock).not.toBeNull();
      expect(wrap).not.toBeNull();
      expect(copy).not.toBeNull();

      await click(wrap!);
      expect(codeBlock?.dataset.wrap).toBe("false");
      const updatedWrap = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Wrap lines"]',
      );
      expect(updatedWrap?.getAttribute("aria-pressed")).toBe("false");

      await click(copy!);
      expect(writeText).toHaveBeenCalledWith("const value = 1;\n");
      expect(container.querySelector('button[aria-label="Copied"]')).not.toBeNull();
    });

    it("skips the highlight cache while streaming", async () => {
      const markup = await renderMarkdown(["```ts", "const streaming = true;", "```"].join("\n"), {
        isStreaming: true,
      });

      expect(markup).toContain('data-language="ts"');
      expect(markup).toContain("streaming");
    });

    it("emits highlighted markup once the shared highlighter resolves", async () => {
      const markup = await renderMarkdownUntilHighlighted(
        ["```ts", "const answer = 42;", "```"].join("\n"),
      );

      expect(markup).toContain("chat-markdown-shiki");
      expect(markup).toContain("shiki");
      expect(markup).toContain("answer");
      expect(markup).toContain('<span class="line">');
    });

    it("keeps rendering fence content when the grammar cannot be loaded", async () => {
      // Unknown grammars reject the highlighter promise; the fence must keep
      // showing its content through the plain <pre> fallback. The wait lets the
      // rejection handler (fallback to the "text" grammar) run.
      const text = ["```someunknownlanguage", "raw fallback content", "```"].join("\n");
      const first = await renderMarkdown(text);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await renderMarkdown(text);

      expect(first).toContain("raw fallback content");
      expect(second).toContain("raw fallback content");
      expect(second).toContain('data-language="someunknownlanguage"');
    });

    it("renders raw pre elements without code children untouched", async () => {
      const markup = await renderMarkdown("<pre>plain preformatted</pre>");

      expect(markup).toContain("plain preformatted");
      expect(markup).not.toContain("chat-markdown-codeblock");
    });

    it("flattens nested markup inside raw code blocks to plain text", async () => {
      const markup = await renderMarkdown("<pre><code>text <b>bold</b> tail</code></pre>");

      expect(markup).toContain("chat-markdown-codeblock");
      expect(markup).toContain("text");
      expect(markup).toContain("bold");
    });

    it("leaves pre elements with multiple children as plain pre blocks", async () => {
      const markup = await renderMarkdown("<pre><code>first</code><code>second</code></pre>");

      expect(markup).toContain("first");
      expect(markup).toContain("second");
      expect(markup).not.toContain("chat-markdown-codeblock");
    });
  });

  describe("mounted interaction edge cases", () => {
    it("ignores a task checkbox when its source marker metadata is missing", async () => {
      const onTaskListChange = vi.fn();
      const container = await mountMarkdown("- [ ] alpha", { onTaskListChange });
      const item = container.querySelector("li");
      const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Toggle task"]');
      item?.removeAttribute("data-task-marker-offset");

      await click(checkbox!);

      expect(onTaskListChange).not.toHaveBeenCalled();
    });

    it("expands collapsed tables and measures every header column", async () => {
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: false });
      const container = await mountMarkdown(["| A | B |", "| - | - |", "| one | two |"].join("\n"));
      const cells = [...container.querySelectorAll<HTMLElement>("th, td")];
      const headerCells = [...container.querySelectorAll<HTMLElement>("th")];
      const table = container.querySelector<HTMLTableElement>("table")!;
      Object.defineProperty(table, "tHead", {
        configurable: true,
        value: { rows: [{ cells: headerCells }] },
      });
      cells.forEach((cell, index) => {
        vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
          width: 20 + index,
        } as DOMRect);
      });

      await click(
        container.querySelector<HTMLButtonElement>('button[aria-label="Expand table cells"]')!,
      );

      expect(
        container.querySelector(".chat-markdown-table-container")?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(container.querySelectorAll("th")[0]?.style.minWidth).not.toBe("");
    });

    it("toggles details content through the rendered summary", async () => {
      const container = await mountMarkdown(
        ["<details>", "<summary>More</summary>", "", "Body", "", "</details>"].join("\n"),
      );
      const details = container.querySelector<HTMLElement>("[data-markdown-details]");
      expect(details?.dataset.markdownDetailsOpen).toBe("false");

      await click(container.querySelector<HTMLElement>("[data-markdown-details-summary]")!);

      expect(details?.dataset.markdownDetailsOpen).toBe("true");
    });

    it("navigates valid fragment links and preserves modified clicks", async () => {
      const container = await mountMarkdown("# Target\n\n[Jump](#target)");
      const target = document.createElement("div");
      target.id = "target";
      document.body.append(target);
      const anchor = container.querySelector<HTMLAnchorElement>('a[href="#target"]');
      const scrollIntoView = vi.fn();
      Object.defineProperty(target, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });

      await act(async () =>
        anchor!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(window.location.hash).toBe("#target");

      scrollIntoView.mockClear();
      await act(async () =>
        anchor!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
        ),
      );
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("reports code clipboard failure and ignores an unavailable clipboard", async () => {
      const container = await mountMarkdown(
        ["```ts title=sample.ts", "const x = 1;", "```"].join("\n"),
      );
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!);

      const failure = new Error("copy failed");
      installClipboard(vi.fn(async () => Promise.reject(failure)));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!);
      await act(async () => Promise.resolve());
      expect(consoleError).toHaveBeenCalledWith(
        "[chat-markdown] action failed",
        {
          operation: "copy-code-block",
          language: "ts",
          fenceTitle: "sample.ts",
        },
        failure,
      );
    });
  });
});
