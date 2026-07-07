/**
 * Tests for the markdown clipboard serializer.
 *
 * `markdown-clipboard.ts` walks a live DOM subtree and turns it back into
 * markdown source. The web test runner has no jsdom/happy-dom (see the
 * hand-rolled FakeElement in `contextMenuFallback.test.ts`), so this file
 * installs a small, purpose-built fake DOM: element/text/comment/fragment
 * nodes plus `document.createElement`, a `Node` polyfill, and
 * querySelector/querySelectorAll/closest implementations that handle only the
 * exact selector literals the source uses (switched on the literal string,
 * with an explicit tree walk per case — no CSS engine).
 */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  chatMarkdownClipboardPayload,
  serializeRenderedMarkdownFragment,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "./markdown-clipboard";

// ── Fake DOM ─────────────────────────────────────────────────────────
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const COMMENT_NODE = 8;
const FRAGMENT_NODE = 11;

const SANITIZED_HTML_SELECTOR =
  'button, input, script, style, svg, [aria-hidden="true"], .select-none, .sr-only';

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta"]);

type FakeNode = FakeElement | FakeText | FakeComment;

class FakeText {
  readonly nodeType = TEXT_NODE;
  parentNode: FakeElement | null = null;
  constructor(public textContent: string) {}
  get childNodes(): FakeNode[] {
    return [];
  }
  get nodeValue(): string {
    return this.textContent;
  }
}

class FakeComment {
  readonly nodeType = COMMENT_NODE;
  parentNode: FakeElement | null = null;
  textContent = "";
  get childNodes(): FakeNode[] {
    return [];
  }
}

class FakeFragment {
  readonly nodeType = FRAGMENT_NODE;
  childNodes: FakeNode[] = [];
  appendChild(child: FakeNode): FakeNode {
    this.childNodes.push(child);
    return child;
  }
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  readonly tagName: string;
  readonly localName: string;
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  checked = false;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    this.localName = tag.toLowerCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n.nodeType === ELEMENT_NODE);
  }

  get parentElement(): FakeElement | null {
    return this.parentNode;
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(value: string) {
    this.attributes.set("class", value);
  }

  get classList(): { contains: (name: string) => boolean } {
    const classes = this.className.split(/\s+/).filter(Boolean);
    return { contains: (name: string) => classes.includes(name) };
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) ?? null) : null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: FakeNode | FakeFragment): FakeNode | FakeFragment {
    if (child instanceof FakeFragment) {
      for (const grandchild of [...child.childNodes]) {
        this.appendChild(grandchild);
      }
      return child;
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(value));
  }

  get innerHTML(): string {
    return this.childNodes.map(serializeHtml).join("");
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === "code") {
      return descendants(this).find((el) => el.localName === "code") ?? null;
    }
    if (selector === 'input[type="checkbox"]') {
      return (
        descendants(this).find(
          (el) => el.localName === "input" && el.getAttribute("type") === "checkbox",
        ) ?? null
      );
    }
    if (selector === ":scope > p") {
      return this.children.find((el) => el.localName === "p") ?? null;
    }
    if (selector === ":scope > [data-markdown-details-summary]") {
      return this.children.find((el) => el.hasAttribute("data-markdown-details-summary")) ?? null;
    }
    if (selector === ":scope > * [data-markdown-details-content]") {
      for (const child of this.children) {
        const found = descendants(child).find((el) =>
          el.hasAttribute("data-markdown-details-content"),
        );
        if (found) return found;
      }
      return null;
    }
    throw new Error(`querySelector: unhandled selector ${selector}`);
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === ":scope > thead > tr, :scope > tbody > tr, :scope > tr") {
      const rows: FakeElement[] = [];
      for (const child of this.children) {
        if (child.localName === "thead" || child.localName === "tbody") {
          for (const grandchild of child.children) {
            if (grandchild.localName === "tr") rows.push(grandchild);
          }
        } else if (child.localName === "tr") {
          rows.push(child);
        }
      }
      return rows;
    }
    if (selector === SANITIZED_HTML_SELECTOR) {
      return descendants(this).filter((el) => matchesSanitizedSelector(el));
    }
    throw new Error(`querySelectorAll: unhandled selector ${selector}`);
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (selector === "[data-language]" && current.hasAttribute("data-language")) return current;
      if (
        selector === ".chat-markdown-file-link" &&
        current.classList.contains("chat-markdown-file-link")
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
}

function descendants(element: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: FakeElement): void => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(element);
  return out;
}

function matchesSanitizedSelector(element: FakeElement): boolean {
  if (["button", "input", "script", "style", "svg"].includes(element.localName)) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  if (element.classList.contains("select-none")) return true;
  if (element.classList.contains("sr-only")) return true;
  return false;
}

function serializeHtml(node: FakeNode): string {
  if (node.nodeType === TEXT_NODE) return (node as FakeText).textContent;
  if (node.nodeType !== ELEMENT_NODE) return "";
  const element = node as FakeElement;
  const attrs = [...element.attributes.entries()]
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  if (VOID_TAGS.has(element.localName)) return `<${element.localName}${attrs}>`;
  return `<${element.localName}${attrs}>${element.childNodes.map(serializeHtml).join("")}</${element.localName}>`;
}

// ── Builders ─────────────────────────────────────────────────────────
type Attrs = Record<string, string | boolean | Record<string, string>>;

function el(tag: string, attrs: Attrs = {}, ...children: Array<FakeNode | string>): FakeElement {
  const element = new FakeElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "style" && typeof value === "object") {
      Object.assign(element.style, value);
      continue;
    }
    if (key === "checked") {
      element.checked = Boolean(value);
      continue;
    }
    element.setAttribute(key, String(value));
  }
  for (const child of children) {
    element.appendChild(typeof child === "string" ? new FakeText(child) : child);
  }
  return element;
}

function t(value: string): FakeText {
  return new FakeText(value);
}

function comment(): FakeComment {
  return new FakeComment();
}

class FakeRange {
  constructor(
    public collapsed: boolean,
    private readonly contents: FakeNode[],
  ) {}
  cloneContents(): FakeFragment {
    const fragment = new FakeFragment();
    for (const node of this.contents) fragment.appendChild(node);
    return fragment;
  }
}

class FakeSelection {
  constructor(private readonly ranges: FakeRange[]) {}
  get rangeCount(): number {
    return this.ranges.length;
  }
  getRangeAt(index: number): FakeRange {
    return this.ranges[index]!;
  }
}

function serialize(...nodes: FakeNode[]): string {
  const container = el("div", {}, ...nodes);
  return serializeRenderedMarkdownFragment(container as unknown as Node);
}

// ── Global install ───────────────────────────────────────────────────
const globalRef = globalThis as unknown as { Node?: unknown; document?: unknown };
let originalNode: unknown;
let originalDocument: unknown;

// `Node` must be a constructor so unrelated `x instanceof Node` checks inside
// the test runner's matchers keep working; the source only reads its static
// TEXT_NODE / ELEMENT_NODE constants.
function NodeCtor(): void {}
NodeCtor.TEXT_NODE = TEXT_NODE;
NodeCtor.ELEMENT_NODE = ELEMENT_NODE;

beforeEach(() => {
  originalNode = globalRef.Node;
  originalDocument = globalRef.document;
  globalRef.Node = NodeCtor;
  globalRef.document = { createElement: (tag: string) => new FakeElement(tag) };
});

afterEach(() => {
  globalRef.Node = originalNode;
  globalRef.document = originalDocument;
});

// ── serializeNode / serializeChildren ────────────────────────────────
describe("serializeRenderedMarkdownFragment: text and skipped nodes", () => {
  it("passes real inline text through", () => {
    expect(serialize(el("p", {}, "hello world"))).toBe("hello world");
  });

  it("collapses inter-block formatting whitespace to a newline", () => {
    expect(serialize(t("\n   \n"))).toBe("");
  });

  it("ignores comment (non-element, non-text) nodes", () => {
    expect(serialize(el("p", {}, "a", comment(), "b"))).toBe("ab");
  });

  it("skips button/svg/aria-hidden/select-none/sr-only elements", () => {
    expect(serialize(el("button", {}, "x"))).toBe("");
    expect(serialize(el("svg", {}, "x"))).toBe("");
    expect(serialize(el("span", { "aria-hidden": "true" }, "x"))).toBe("");
    expect(serialize(el("span", { class: "select-none" }, "x"))).toBe("");
    expect(serialize(el("span", { class: "sr-only" }, "x"))).toBe("");
  });

  it("returns the data-markdown-copy override verbatim", () => {
    expect(serialize(el("span", { "data-markdown-copy": "@user" }, "ignored"))).toBe("@user");
  });
});

describe("serializeRenderedMarkdownFragment: block elements", () => {
  it("renders headings h1..h6", () => {
    expect(serialize(el("h1", {}, "Title"))).toBe("# Title");
    expect(serialize(el("h3", {}, "Sub"))).toBe("### Sub");
    expect(serialize(el("h6", {}, "Deep"))).toBe("###### Deep");
  });

  it("renders BR and HR", () => {
    expect(serialize(el("p", {}, "a", el("br"), "b"))).toBe("a\nb");
    expect(serialize(el("hr"))).toBe("---");
  });

  it("renders paragraphs", () => {
    expect(serialize(el("p", {}, "one"), el("p", {}, "two"))).toBe("one\n\ntwo");
  });

  it("renders emphasis, strong and strikethrough with hoisted whitespace", () => {
    expect(serialize(el("strong", {}, "bold"))).toBe("**bold**");
    expect(serialize(el("b", {}, "bold"))).toBe("**bold**");
    expect(serialize(el("em", {}, "it"))).toBe("*it*");
    expect(serialize(el("i", {}, "it"))).toBe("*it*");
    expect(serialize(el("del", {}, "gone"))).toBe("~~gone~~");
    expect(serialize(el("s", {}, "gone"))).toBe("~~gone~~");
  });

  it("hoists surrounding whitespace outside inline markers", () => {
    expect(serialize(el("p", {}, "x", el("strong", {}, " bold "), "y"))).toBe("x **bold** y");
  });

  it("leaves whitespace-only inline markers untouched", () => {
    expect(serialize(el("p", {}, "a", el("em", {}, "   "), "b"))).toBe("a   b");
  });
});

describe("serializeRenderedMarkdownFragment: inline code and code blocks", () => {
  it("wraps inline code and pads when it contains backticks", () => {
    expect(serialize(el("code", {}, "x = 1"))).toBe("`x = 1`");
    expect(serialize(el("code", {}, "a`b"))).toBe("``a`b``");
    expect(serialize(el("code", {}, "`lead"))).toBe("`` `lead ``");
  });

  it("serializes a fenced code block and strips the trailing newline", () => {
    const pre = el("pre", { "data-language": "ts" }, el("code", { class: "language-ts" }, "const a = 1\n"));
    expect(serialize(pre)).toBe("```ts\nconst a = 1\n```");
  });

  it("resolves the language from a language- class when no data-language is set", () => {
    const pre = el("pre", {}, el("code", { class: "hljs language-js" }, "let a"));
    expect(serialize(pre)).toBe("```js\nlet a\n```");
  });

  it("omits a language of 'text'", () => {
    const pre = el("pre", { "data-language": "text" }, el("code", {}, "plain"));
    expect(serialize(pre)).toBe("```\nplain\n```");
  });

  it("widens the fence when the code contains a triple backtick run", () => {
    const pre = el("pre", {}, el("code", {}, "```\nnested\n```"));
    expect(serialize(pre)).toBe("````\n```\nnested\n```\n````");
  });
});

describe("serializeRenderedMarkdownFragment: links and images", () => {
  it("renders an http link", () => {
    expect(serialize(el("a", { href: "https://ex.com" }, "Example"))).toBe("[Example](https://ex.com)");
  });

  it("returns the raw url when label equals href", () => {
    expect(serialize(el("a", { href: "https://ex.com" }, "https://ex.com"))).toBe("https://ex.com");
  });

  it("returns just the content for non-http links", () => {
    expect(serialize(el("a", { href: "/local/path" }, "local"))).toBe("local");
  });

  it("drops http links with an empty label", () => {
    expect(serialize(el("a", { href: "https://ex.com" }, "   "))).toBe("");
  });

  it("renders an image with alt + src and drops incomplete images", () => {
    expect(serialize(el("img", { alt: "cat", src: "cat.png" }))).toBe("![cat](cat.png)");
    expect(serialize(el("img", { alt: "", src: "cat.png" }))).toBe("");
    expect(serialize(el("img", { alt: "x" }))).toBe("");
  });
});

describe("serializeRenderedMarkdownFragment: containers and unknown tags", () => {
  it("appends a newline when div content does not end with one", () => {
    expect(serialize(el("div", {}, el("code", {}, "x")), el("p", {}, "next"))).toBe("`x`\nnext");
  });

  it("keeps section/article content that already ends with a newline", () => {
    expect(serialize(el("section", {}, el("p", {}, "hi")))).toBe("hi");
    expect(serialize(el("article", {}, el("p", {}, "yo")))).toBe("yo");
  });

  it("returns empty for an empty container element", () => {
    expect(serialize(el("div"))).toBe("");
  });

  it("falls through unknown tags to their children", () => {
    expect(serialize(el("span", {}, "plain"))).toBe("plain");
  });
});

describe("serializeRenderedMarkdownFragment: lists", () => {
  it("renders an unordered list", () => {
    expect(serialize(el("ul", {}, el("li", {}, "first"), el("li", {}, "second")))).toBe(
      "- first\n- second",
    );
  });

  it("renders an ordered list honoring the start attribute", () => {
    expect(serialize(el("ol", { start: "3" }, el("li", {}, "c"), el("li", {}, "d")))).toBe(
      "3. c\n4. d",
    );
  });

  it("returns empty for a list with no items", () => {
    expect(serialize(el("ul"))).toBe("");
  });

  it("renders checked and unchecked task list items", () => {
    const list = el(
      "ul",
      {},
      el("li", {}, el("input", { type: "checkbox", checked: true }), "done"),
      el("li", {}, el("input", { type: "checkbox", checked: false }), "todo"),
    );
    expect(serialize(list)).toBe("- [x] done\n- [ ] todo");
  });

  it("indents nested list continuation lines (tight item)", () => {
    const list = el(
      "ul",
      {},
      // The formatting whitespace text node between "Parent" and the nested
      // list mirrors how the renderer emits source and becomes a newline.
      el("li", {}, t("Parent"), t("\n"), el("ul", {}, el("li", {}, "Child"))),
    );
    expect(serialize(list)).toBe("- Parent\n  - Child");
  });

  it("keeps loose list items with paragraph children spaced", () => {
    const list = el("ul", {}, el("li", {}, el("p", {}, "loose")));
    expect(serialize(list)).toBe("- loose");
  });
});

describe("serializeRenderedMarkdownFragment: blockquotes and details", () => {
  it("renders a blockquote, prefixing each line", () => {
    const quote = el("blockquote", {}, el("p", {}, "line one"), el("p", {}, "line two"));
    expect(serialize(quote)).toBe("> line one\n>\n> line two");
  });

  it("returns empty for an empty blockquote", () => {
    expect(serialize(el("blockquote"))).toBe("");
  });

  it("renders an open details block with summary + content", () => {
    const details = el(
      "div",
      { "data-markdown-details": "", "data-markdown-details-open": "true" },
      el("summary", { "data-markdown-details-summary": "" }, "Summary text"),
      el("div", {}, el("div", { "data-markdown-details-content": "" }, el("p", {}, "Body"))),
    );
    expect(serialize(details)).toBe(
      "<details open>\n<summary>Summary text</summary>\n\nBody\n</details>",
    );
  });

  it("falls back to a default summary and no content", () => {
    const details = el("div", { "data-markdown-details": "" });
    expect(serialize(details)).toBe("<details>\n<summary>Details</summary>\n</details>");
  });
});

describe("serializeRenderedMarkdownFragment: tables", () => {
  it("renders a table with alignment markers", () => {
    const table = el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { style: { textAlign: "center" } }, "C"),
          el("th", { align: "right" }, "R"),
          el("th", {}, "L"),
        ),
      ),
      el("tbody", {}, el("tr", {}, el("td", {}, "1"), el("td", {}, "2"), el("td", {}, "3"))),
    );
    expect(serialize(table)).toBe("| C | R | L |\n| :---: | ---: | --- |\n| 1 | 2 | 3 |");
  });

  it("escapes pipes inside table cells and skips cell-less rows", () => {
    const table = el(
      "table",
      {},
      el("tr", {}, el("td", {}, "a|b"), el("td", {}, "plain")),
      el("tr", {}), // no cells -> skipped
    );
    expect(serialize(table)).toBe("| a\\|b | plain |\n| --- | --- |");
  });

  it("returns empty for a table with no rows", () => {
    expect(serialize(el("table"))).toBe("");
  });
});

// ── Standalone table serializers ─────────────────────────────────────
describe("serializeTableElementToMarkdown", () => {
  it("serializes a table element to trimmed markdown", () => {
    const table = el(
      "table",
      {},
      el("tr", {}, el("th", {}, "H1"), el("th", {}, "H2")),
      el("tr", {}, el("td", {}, "a"), el("td", {}, "b")),
    );
    expect(serializeTableElementToMarkdown(table as unknown as Element)).toBe(
      "| H1 | H2 |\n| --- | --- |\n| a | b |",
    );
  });
});

describe("serializeTableElementToCsv", () => {
  it("serializes cells, quoting values with commas, quotes and newlines", () => {
    const table = el(
      "table",
      {},
      el("tr", {}, el("th", {}, "plain"), el("th", {}, "a,b"), el("th", {}, 'say "hi"')),
      el("tr", {}, el("td", {}, "x"), el("td", {}, "line\nbreak"), el("td", {}, "  spaced  ")),
      el("tr", {}), // cell-less row skipped
    );
    // Newlines are normalized to spaces before the quoting test, so the
    // "line\nbreak" cell is not quoted.
    expect(serializeTableElementToCsv(table as unknown as Element)).toBe(
      'plain,"a,b","say ""hi"""\nx,line break,spaced',
    );
  });
});

// ── tidyMarkdown (via full fragment with a code fence) ───────────────
describe("serializeRenderedMarkdownFragment: tidy pass", () => {
  it("preserves fenced code while collapsing blank runs elsewhere", () => {
    const fragment = serialize(
      el("p", {}, "before"),
      el("pre", {}, el("code", {}, "a\n\n\nb")),
      el("p", {}, "after"),
    );
    // The blank-run inside the fence is preserved verbatim; the paragraphs
    // around it are separated by a single blank line.
    expect(fragment).toBe("before\n\n```\na\n\n\nb\n```\n\nafter");
  });
});

// ── chatMarkdownClipboardPayload ─────────────────────────────────────
describe("chatMarkdownClipboardPayload", () => {
  it("returns null when every range is collapsed", () => {
    const selection = new FakeSelection([new FakeRange(true, [el("p", {}, "ignored")])]);
    expect(chatMarkdownClipboardPayload(selection as unknown as Selection)).toBeNull();
  });

  it("skips ranges that serialize to empty text and returns null overall", () => {
    const selection = new FakeSelection([new FakeRange(false, [el("button", {}, "x")])]);
    expect(chatMarkdownClipboardPayload(selection as unknown as Selection)).toBeNull();
  });

  it("builds a text + html payload from a single range", () => {
    const selection = new FakeSelection([
      new FakeRange(false, [el("p", {}, "hello ", el("strong", {}, "world"))]),
    ]);
    const payload = chatMarkdownClipboardPayload(selection as unknown as Selection);
    expect(payload).not.toBeNull();
    expect(payload?.text).toBe("hello **world**");
    expect(payload?.html.startsWith('<meta charset="utf-8">')).toBe(true);
    expect(payload?.html).toContain("<strong>world</strong>");
  });

  it("joins text from multiple ranges", () => {
    const selection = new FakeSelection([
      new FakeRange(false, [el("p", {}, "one")]),
      new FakeRange(false, [el("p", {}, "two")]),
    ]);
    const payload = chatMarkdownClipboardPayload(selection as unknown as Selection);
    expect(payload?.text).toBe("one\n\ntwo");
  });

  it("strips disallowed nodes from the html but keeps file-link content", () => {
    const fileLink = el(
      "a",
      { href: "https://ex.com/file", class: "chat-markdown-file-link" },
      el("svg", {}, "icon"), // svg inside link -> removed
      el("span", { "aria-hidden": "true" }, "hidden"), // aria-hidden inside link -> removed
      el("button", {}, "keep-me"), // matched but not svg/aria-hidden inside link -> kept
      t("file.ts"),
    );
    const selfClassedKept = el("span", { class: "select-none chat-markdown-file-link" }, "kept");
    const range = new FakeRange(false, [
      el("p", {}, "text ", el("button", {}, "toolbar"), fileLink, selfClassedKept),
    ]);
    const payload = chatMarkdownClipboardPayload(new FakeSelection([range]) as unknown as Selection);
    expect(payload).not.toBeNull();
    const html = payload!.html;
    expect(html).not.toContain("<svg");
    expect(html).not.toContain(">hidden<");
    expect(html).not.toContain(">toolbar<");
    expect(html).toContain(">keep-me<");
    expect(html).toContain(">kept<");
    expect(html).toContain("file.ts");
  });
});
