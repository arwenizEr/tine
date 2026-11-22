// Markdown to HTML using the Lezer parser CodeMirror already ships. Every piece of text is
// escaped and only a fixed set of tags is emitted, so raw HTML in a file is shown as text.
import { GFM, parser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";

const md = parser.configure(GFM);

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Only web and mail links are clickable; relative and other links render inert. */
const safeHref = (url: string) => (/^(https?:|mailto:)/i.test(url) ? url : "#");

const MARKS = new Set([
  "HeaderMark", "EmphasisMark", "CodeMark", "LinkMark", "ListMark", "QuoteMark", "StrikethroughMark",
  "TableDelimiter", "CodeInfo", "LinkTitle", "LinkLabel", "TaskMarker", "LinkReference",
]);

const TAGS: Record<string, string> = {
  Paragraph: "p", ATXHeading1: "h1", ATXHeading2: "h2", ATXHeading3: "h3", ATXHeading4: "h4",
  ATXHeading5: "h5", ATXHeading6: "h6", SetextHeading1: "h1", SetextHeading2: "h2", Emphasis: "em",
  StrongEmphasis: "strong", Strikethrough: "del", InlineCode: "code", Blockquote: "blockquote",
  BulletList: "ul", OrderedList: "ol", ListItem: "li", Table: "table", TableHeader: "tr", TableRow: "tr",
};

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

function inner(node: SyntaxNode, src: string, skip: Set<string> = MARKS): string {
  let html = "";
  let pos = node.from;
  for (const c of children(node)) {
    html += escape(src.slice(pos, c.from));
    if (!skip.has(c.name)) html += render(c, src);
    pos = c.to;
  }
  return html + escape(src.slice(pos, node.to));
}

const text = (node: SyntaxNode, src: string) => src.slice(node.from, node.to);
const child = (node: SyntaxNode, name: string) => children(node).find((c) => c.name === name);
const link = (url: string, label: string) => `<a href="${escape(safeHref(url))}">${label}</a>`;

function render(node: SyntaxNode, src: string): string {
  switch (node.name) {
    case "HorizontalRule":
      return "<hr>";
    case "HardBreak":
      return "<br>";
    case "Escape":
      return escape(text(node, src).slice(1));
    case "FencedCode":
    case "CodeBlock": {
      const code = children(node).filter((c) => c.name === "CodeText").map((c) => text(c, src)).join("\n");
      return `<pre><code>${escape(code)}</code></pre>`;
    }
    case "Link": {
      const url = child(node, "URL");
      const labelSkip = new Set([...MARKS, "URL"]);
      return link(url ? text(url, src) : "", inner(node, src, labelSkip));
    }
    case "Autolink":
    case "URL": {
      const url = node.name === "URL" ? node : child(node, "URL");
      const href = url ? text(url, src) : "";
      return link(href, escape(href));
    }
    case "Image": {
      // Images are not loaded: show the alt text in their place.
      const alt = inner(node, src, new Set([...MARKS, "URL"]));
      return `<span class="md-image">[${alt}]</span>`;
    }
    case "Task": {
      const marker = child(node, "TaskMarker");
      const checked = marker && /x/i.test(text(marker, src)) ? " checked" : "";
      return `<input type="checkbox" disabled${checked}>${inner(node, src)}`;
    }
    case "TableCell": {
      const tag = node.parent?.name === "TableHeader" ? "th" : "td";
      return `<${tag}>${inner(node, src)}</${tag}>`;
    }
    case "HTMLBlock":
    case "HTMLTag":
    case "CommentBlock":
    case "Comment":
    case "ProcessingInstructionBlock":
    case "ProcessingInstruction":
      return escape(text(node, src));
  }
  const tag = TAGS[node.name];
  return tag ? `<${tag}>${inner(node, src)}</${tag}>` : inner(node, src);
}

export function renderMarkdown(src: string): string {
  return render(md.parse(src).topNode, src);
}
