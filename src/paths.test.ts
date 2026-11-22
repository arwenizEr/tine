import { test } from "node:test";
import assert from "node:assert/strict";
import { ancestors, dirname, findPathLinks, isInside, join, lineRef, normalize, parseOsc7, resolve, shellQuote } from "./paths.ts";

test("dirname, join, normalize, resolve", () => {
  assert.equal(dirname("/a/b/c.txt"), "/a/b");
  assert.equal(dirname("/a"), "/");
  assert.equal(join("/", "a"), "/a");
  assert.equal(join("/a", "b"), "/a/b");
  assert.equal(normalize("/a/./b/../c/"), "/a/c");
  assert.equal(normalize("/../.."), "/");
  assert.equal(resolve("/repo/src", "../README.md"), "/repo/README.md");
  assert.equal(resolve("/repo", "/etc/hosts"), "/etc/hosts");
  assert.deepEqual(ancestors("/a/b"), ["/a/b", "/a", "/"]);
  assert.ok(isInside("/a", "/a/b") && isInside("/a", "/a") && !isInside("/a", "/ab"));
});

test("parseOsc7 decodes the path and ignores the host", () => {
  assert.equal(parseOsc7("file://mac.local/Users/me/my%20dir"), "/Users/me/my dir");
  assert.equal(parseOsc7("file:///tmp"), "/tmp");
  assert.equal(parseOsc7("file://host/50%25"), "/50%");
  assert.equal(parseOsc7("file://host/bad%zz"), null);
  assert.equal(parseOsc7("http://x/y"), null);
});

test("shellQuote survives quotes and spaces", () => {
  assert.equal(shellQuote("/a b/c"), "'/a b/c'");
  assert.equal(shellQuote("/it's"), `'/it'\\''s'`);
});

const paths = (line: string) => findPathLinks(line).map((l) => [l.path, l.line, l.col, line.slice(l.start, l.end)]);

test("findPathLinks finds compiler-style locations", () => {
  assert.deepEqual(paths("error at src/main.rs:12:5: oops"), [["src/main.rs", 12, 5, "src/main.rs:12:5"]]);
  assert.deepEqual(paths("  --> ./lib/a.ts:3"), [["./lib/a.ts", 3, undefined, "./lib/a.ts:3"]]);
  assert.deepEqual(paths("open /etc/hosts now"), [["/etc/hosts", undefined, undefined, "/etc/hosts"]]);
  assert.deepEqual(paths("Updated README.md."), [["README.md", undefined, undefined, "README.md"]]);
  assert.deepEqual(paths("Edited ../x/y"), [["../x/y", undefined, undefined, "../x/y"]]);
});

test("findPathLinks skips URLs, plain words and version numbers", () => {
  assert.deepEqual(paths("see https://example.com/a/b.html"), []);
  assert.deepEqual(paths("hello world"), []);
  assert.deepEqual(paths("node v26.13.1 and 1.2"), []);
  assert.deepEqual(paths("cd .."), []);
});

test("lineRef", () => {
  assert.equal(lineRef("/r/src/a.ts", "/r", 3, 7), "src/a.ts:3-7");
  assert.equal(lineRef("/r/src/a.ts", "/r", 4, 4), "src/a.ts:4");
  assert.equal(lineRef("/other/a.ts", "/r", 1, 2), "/other/a.ts:1-2");
  assert.equal(lineRef("/rx/a.ts", "/r", 1, 1), "/rx/a.ts:1");
  assert.equal(lineRef("/a.ts", "/", 1, 1), "a.ts:1");
  assert.equal(lineRef("/r/a.ts", null, 1, 1), "/r/a.ts:1");
});
