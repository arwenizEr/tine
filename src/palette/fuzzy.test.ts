import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, rank } from "./fuzzy.ts";

test("matches subsequences only", () => {
  assert.notEqual(fuzzyScore("mnts", "src/main.ts"), null);
  assert.equal(fuzzyScore("xyz", "src/main.ts"), null);
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("file names and word starts beat scattered matches", () => {
  const files = ["src/terminal/index.ts", "src/viewer/index.ts", "src/terminal/tabbar.ts", "docs/notes/term.md"];
  assert.equal(rank("tabbar", files, (f) => f, 1)[0], "src/terminal/tabbar.ts");
  assert.equal(rank("viewidx", files, (f) => f, 1)[0], "src/viewer/index.ts");
  assert.deepEqual(rank("zzz", files, (f) => f, 5), []);
});

test("rank keeps at most `limit` results", () => {
  const files = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`);
  assert.equal(rank("file", files, (f) => f, 10).length, 10);
});
