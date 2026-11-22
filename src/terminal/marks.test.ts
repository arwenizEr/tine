import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCommand, formatDuration, notification, parseMark, signedBy } from "./marks.ts";

test("parseMark reads prompt, command and end marks", () => {
  assert.deepEqual(parseMark("A"), { kind: "A" });
  assert.deepEqual(parseMark("C"), { kind: "C" });
  assert.deepEqual(parseMark("D;0"), { kind: "D", exit: 0 });
  assert.deepEqual(parseMark("D;130"), { kind: "D", exit: 130 });
  assert.deepEqual(parseMark("D"), { kind: "D", exit: null });
  assert.deepEqual(parseMark("D;x"), { kind: "D", exit: null });
  assert.equal(parseMark("Z"), null);
});

test("decodeCommand undoes the shell's percent-encoding", () => {
  assert.equal(decodeCommand("echo 50%25"), "echo 50%");
  assert.equal(decodeCommand("for x in 1 2%0Ado echo $x%0Adone"), "for x in 1 2\ndo echo $x\ndone");
  assert.equal(decodeCommand("printf %zz"), "printf %zz");
});

test("formatDuration", () => {
  assert.equal(formatDuration(420), "0.4s");
  assert.equal(formatDuration(12_400), "12s");
  assert.equal(formatDuration(185_000), "3m 05s");
});

test("signedBy accepts only marks carrying the session token", () => {
  assert.equal(signedBy("A;tine=abc123", "abc123"), "A");
  assert.equal(signedBy("D;3;tine=abc123", "abc123"), "D;3");
  assert.equal(signedBy("E;false%3B(exit 3);tine=abc123", "abc123"), "E;false%3B(exit 3)");
  assert.equal(signedBy("A", "abc123"), null);
  assert.equal(signedBy("A;tine=guess", "abc123"), null);
  assert.equal(signedBy("A;tine=abc123x", "abc123"), null);
});

test("notification names tine and the tab, flattens and caps the text", () => {
  assert.deepEqual(notification("claude", "Claude needs your permission"), { title: "tine · claude", body: "Claude needs your permission" });
  assert.deepEqual(notification("", "done"), { title: "tine", body: "done" });
  assert.equal(notification("x", "line one\n\n\x1b[31mline two").body, "line one [31mline two");
  assert.equal(notification("x", "a".repeat(500)).body.length, 200);
  assert.equal(notification("t".repeat(99), "").title, `tine · ${"t".repeat(39)}…`);
});
