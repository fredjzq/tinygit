// Myers diff 正确性。

import { test } from "node:test";
import assert from "node:assert/strict";
import { myersDiff, formatUnified, splitLines, toHunks } from "../src/diff.js";

function apply(a, ops) {
  const out = [];
  for (const o of ops) {
    if (o.op === " " || o.op === "-") out.push(o.line);
  }
  return out;
}

function reconstruct(ops) {
  const removed = ops.filter((o) => o.op !== "+").map((o) => o.line);
  const added = ops.filter((o) => o.op !== "-").map((o) => o.line);
  return { removed, added };
}

test("identical inputs produce no changes", () => {
  const ops = myersDiff(["a", "b"], ["a", "b"]);
  assert.ok(ops.every((o) => o.op === " "));
});

test("pure insertion", () => {
  const ops = myersDiff(["a", "c"], ["a", "b", "c"]);
  const { removed, added } = reconstruct(ops);
  assert.deepEqual(removed, ["a", "c"]);
  assert.deepEqual(added, ["a", "b", "c"]);
});

test("pure deletion", () => {
  const ops = myersDiff(["a", "b", "c"], ["a", "c"]);
  const { removed, added } = reconstruct(ops);
  assert.deepEqual(removed, ["a", "b", "c"]);
  assert.deepEqual(added, ["a", "c"]);
});

test("replacement", () => {
  const ops = myersDiff(["a", "b", "c"], ["a", "x", "c"]);
  const { removed, added } = reconstruct(ops);
  assert.deepEqual(removed, ["a", "b", "c"]);
  assert.deepEqual(added, ["a", "x", "c"]);
});

test("complete rewrite", () => {
  const ops = myersDiff(["a"], ["z"]);
  const { removed, added } = reconstruct(ops);
  assert.deepEqual(removed, ["a"]);
  assert.deepEqual(added, ["z"]);
});

test("diff is minimal for a single change", () => {
  const ops = myersDiff(["a", "b", "c", "d"], ["a", "b", "x", "d"]);
  const editCount = ops.filter((o) => o.op !== " ").length;
  assert.equal(editCount, 2); // 删除 + 添加，这就是最短编辑脚本
});

test("empty to content and back", () => {
  assert.deepEqual(reconstruct(myersDiff([], ["a"])).added, ["a"]);
  assert.deepEqual(reconstruct(myersDiff(["a"], [])).removed, ["a"]);
});

test("splitLines drops the trailing empty line caused by final newline", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("unified diff has correct headers and hunk", () => {
  const patch = formatUnified("a\nb\nc\n", "a\nx\nc\n", { fromName: "a/f", toName: "b/f" });
  assert.match(patch, /^--- a\/f$/m);
  assert.match(patch, /^\+\+\+ b\/f$/m);
  assert.match(patch, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.match(patch, /^-b$/m);
  assert.match(patch, /^\+x$/m);
});

test("no diff returns empty string", () => {
  assert.equal(formatUnified("a\n", "a\n"), "");
});

test("hunks are separated when far apart", () => {
  const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];
  const b = [...a];
  b[0] = "1x";
  b[14] = "15x";
  const hunks = toHunks(myersDiff(a, b), 3);
  assert.ok(hunks.length >= 2, "far-apart changes should produce separate hunks");
});
