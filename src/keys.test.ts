import { test } from "node:test";
import assert from "node:assert/strict";
import { keyAction, SHIFT_ENTER, type KeyLike } from "./keys.ts";

const key = (k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("macOS: Cmd shortcuts map to app actions", () => {
  assert.deepEqual(keyAction(key("t", "KeyT", { metaKey: true }), true), { type: "newTab" });
  assert.deepEqual(keyAction(key("w", "KeyW", { metaKey: true }), true), { type: "closeTab" });
  assert.deepEqual(keyAction(key("k", "KeyK", { metaKey: true }), true), { type: "clear" });
  assert.deepEqual(keyAction(key("3", "Digit3", { metaKey: true }), true), { type: "selectTab", index: 2 });
});

test("macOS: Cmd+C/V go to the native menu, Ctrl goes to the shell", () => {
  assert.equal(keyAction(key("c", "KeyC", { metaKey: true }), true), null);
  assert.equal(keyAction(key("v", "KeyV", { metaKey: true }), true), null);
  assert.equal(keyAction(key("c", "KeyC", { ctrlKey: true }), true), null);
  assert.equal(keyAction(key("t", "KeyT", { ctrlKey: true, shiftKey: true }), true), null);
});

test("Linux: Ctrl+Shift shortcuts, shifted digits still select tabs", () => {
  assert.deepEqual(keyAction(key("T", "KeyT", { ctrlKey: true, shiftKey: true }), false), { type: "newTab" });
  assert.deepEqual(keyAction(key("C", "KeyC", { ctrlKey: true, shiftKey: true }), false), { type: "copy" });
  assert.deepEqual(keyAction(key("V", "KeyV", { ctrlKey: true, shiftKey: true }), false), { type: "paste" });
  assert.deepEqual(keyAction(key("!", "Digit1", { ctrlKey: true, shiftKey: true }), false), { type: "selectTab", index: 0 });
  assert.equal(keyAction(key("c", "KeyC", { ctrlKey: true }), false), null);
  assert.equal(keyAction(key("t", "KeyT", { metaKey: true }), false), null);
});

test("panel toggles on both platforms; New File and Open Folder via menu on macOS", () => {
  assert.deepEqual(keyAction(key("b", "KeyB", { metaKey: true }), true), { type: "toggleSidebar" });
  assert.deepEqual(keyAction(key("J", "KeyJ", { ctrlKey: true, shiftKey: true }), false), { type: "toggleViewer" });
  assert.equal(keyAction(key("n", "KeyN", { metaKey: true }), true), null);
  assert.equal(keyAction(key("o", "KeyO", { metaKey: true }), true), null);
  assert.deepEqual(keyAction(key("N", "KeyN", { ctrlKey: true, shiftKey: true }), false), { type: "newFile" });
  assert.deepEqual(keyAction(key("O", "KeyO", { ctrlKey: true, shiftKey: true }), false), { type: "openFolder" });
});

test("find maps on both platforms", () => {
  assert.deepEqual(keyAction(key("f", "KeyF", { metaKey: true }), true), { type: "find" });
  assert.deepEqual(keyAction(key("F", "KeyF", { ctrlKey: true, shiftKey: true }), false), { type: "find" });
  assert.equal(keyAction(key("f", "KeyF", { ctrlKey: true }), false), null);
});

test("Shift+Enter sends ESC CR; plain Enter goes to the shell", () => {
  assert.deepEqual(keyAction(key("Enter", "Enter", { shiftKey: true }), true), { type: "send", data: SHIFT_ENTER });
  assert.deepEqual(keyAction(key("Enter", "Enter", { shiftKey: true }), false), { type: "send", data: SHIFT_ENTER });
  assert.equal(keyAction(key("Enter", "Enter"), true), null);
});
