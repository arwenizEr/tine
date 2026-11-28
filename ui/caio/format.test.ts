import { test } from "node:test";
import assert from "node:assert/strict";
import { answerMarkdown, parseQuery, searchMarkdown } from "./format.ts";

test("parseQuery takes a library prefix", () => {
  assert.deepEqual(parseQuery("zod: string min length"), { library: "zod", query: "string min length" });
  assert.deepEqual(parseQuery("@tanstack/react-query: retry"), { library: "@tanstack/react-query", query: "retry" });
  assert.deepEqual(parseQuery("  retry with backoff "), { query: "retry with backoff" });
});

test("searchMarkdown shows version source, notes and each result with its source", () => {
  const md = searchMarkdown({
    query: "min length",
    library: "zod",
    version: "4.6.7",
    versionSource: "package-lock.json",
    note: "From the lockfile.",
    results: [{ title: "Strings", library: "zod", version: "4.6.7", verification: "verified", sourceUrl: "https://x/api.mdx", content: "z.string().min(5)" }],
  });
  assert.match(md, /^# min length/);
  assert.match(md, /zod 4\.6\.7 · version from package-lock\.json/);
  assert.match(md, /> From the lockfile\./);
  assert.match(md, /## Strings\n\nzod 4\.6\.7 · verified · \[source\]\(https:\/\/x\/api\.mdx\)\n\nz\.string\(\)\.min\(5\)/);
  assert.match(searchMarkdown({ query: "q", results: [] }), /Nothing found\./);
});

test("answerMarkdown lists fields and puts signatures in code blocks", () => {
  const md = answerMarkdown("zod · string", { exists: true, signature: "string(): ZodString" });
  assert.match(md, /- \*\*exists\*\*: true/);
  assert.match(md, /\*\*signature\*\*\n\n```ts\nstring\(\): ZodString\n```/);
});
