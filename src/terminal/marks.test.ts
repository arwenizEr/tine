import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCommand, formatDuration, parseMark } from "./marks.ts";

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
