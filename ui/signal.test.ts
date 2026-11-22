import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, watch } from "./signal.ts";

test("subscribe runs on change only; watch also runs at once", () => {
  const s = signal(1);
  const seen: number[] = [];
  const watched: number[] = [];
  const unsub = s.subscribe((v) => seen.push(v));
  const unwatch = watch(s, (v) => watched.push(v));
  s.set(1); // same value: no notification
  s.set(2);
  unsub();
  unwatch();
  s.set(3);
  assert.deepEqual(seen, [2]);
  assert.deepEqual(watched, [1, 2]);
});
