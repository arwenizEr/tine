import { test } from "node:test";
import assert from "node:assert/strict";
import { toWebUrl } from "./weburl.ts";

test("toWebUrl adds https and refuses non-web addresses", () => {
  assert.equal(toWebUrl("youtube.com"), "https://youtube.com/");
  assert.equal(toWebUrl(" http://a.b/x?y=1 "), "http://a.b/x?y=1");
  assert.equal(toWebUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(toWebUrl("file:///etc/passwd"), null);
  assert.equal(toWebUrl("javascript:alert(1)"), null);
  assert.equal(toWebUrl("not a url"), null);
  assert.equal(toWebUrl("hello"), null);
});
