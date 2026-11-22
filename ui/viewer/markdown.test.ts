import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.ts";

const html = (s: string) => renderMarkdown(s).replace(/\s+/g, " ").trim();

test("headings, emphasis, code and lists", () => {
  assert.equal(html("# Title"), "<h1> Title</h1>");
  assert.equal(html("a *b* **c** `d` ~~e~~"), "<p>a <em>b</em> <strong>c</strong> <code>d</code> <del>e</del></p>");
  assert.equal(html("- one\n- two"), "<ul><li> <p>one</p></li> <li> <p>two</p></li></ul>");
  assert.equal(html("```js\nlet a = 1 < 2;\n```"), "<pre><code>let a = 1 &lt; 2;</code></pre>");
});

test("links only keep web and mail targets", () => {
  assert.equal(html("[site](https://example.com)"), '<p><a href="https://example.com">site</a></p>');
  assert.equal(html("[x](javascript:alert(1))"), '<p><a href="#">x</a></p>');
  assert.equal(html("[x](docs/a.md)"), '<p><a href="#">x</a></p>');
  assert.equal(html("see https://example.com"), '<p>see <a href="https://example.com">https://example.com</a></p>');
});

test("raw HTML is escaped, never rendered", () => {
  const out = html('<script>alert(1)</script>\n\n<img src=x onerror="y">');
  assert.ok(!out.includes("<script") && !out.includes("<img"), out);
  assert.ok(out.includes("&lt;script&gt;"));
});

test("tables and tasks", () => {
  assert.equal(
    html("| a | b |\n| - | - |\n| 1 | 2 |"),
    "<table><tr> <th>a</th> <th>b</th> </tr> <tr> <td>1</td> <td>2</td> </tr></table>",
  );
  assert.ok(html("- [x] done").includes('<input type="checkbox" disabled checked>'));
});
