// tree 序列化与排序。排序规则错了会导致哈希与真 Git 不一致。

import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeTree, parseTree, sortTreeEntries, padMode } from "../src/tree.js";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

function treeHash(entries) {
  const content = serializeTree(entries);
  const header = Buffer.from("tree " + content.length + "\0", "latin1");
  return createHash("sha1").update(header).update(content).digest("hex");
}

const blobA = "1111111111111111111111111111111111111111";
const blobB = "2222222222222222222222222222222222222222";
const treeC = "3333333333333333333333333333333333333333";

test("directories sort as if they end with a slash", () => {
  // 'foo.txt' 应排在目录 'foo' 之前：'.'(0x2e) < '/'(0x2f)
  const entries = [
    { mode: "40000", name: "foo", oid: treeC, type: "tree" },
    { mode: "100644", name: "foo.txt", oid: blobA, type: "blob" },
  ];
  sortTreeEntries(entries);
  assert.deepEqual(entries.map((e) => e.name), ["foo.txt", "foo"]);
});

test("tree hash is order-independent (sorting normalizes it)", () => {
  const a = [
    { mode: "100644", name: "b.txt", oid: blobB, type: "blob" },
    { mode: "100644", name: "a.txt", oid: blobA, type: "blob" },
  ];
  const b = [
    { mode: "100644", name: "a.txt", oid: blobA, type: "blob" },
    { mode: "100644", name: "b.txt", oid: blobB, type: "blob" },
  ];
  assert.equal(treeHash(a), treeHash(b));
});

test("parseTree roundtrips serializeTree", () => {
  const entries = [
    { mode: "100644", name: "a.txt", oid: blobA, type: "blob" },
    { mode: "100755", name: "run.sh", oid: blobB, type: "blob" },
    { mode: "40000", name: "src", oid: treeC, type: "tree" },
  ];
  const parsed = parseTree(serializeTree(entries));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((e) => e.name).sort(), ["a.txt", "run.sh", "src"]);
  assert.equal(parsed.find((e) => e.name === "src").type, "tree");
  assert.equal(parsed.find((e) => e.name === "a.txt").oid, blobA);
});

test("mode is normalized to 100644 / 100755 / 40000", () => {
  assert.equal(padMode("100644"), "100644");
  assert.equal(padMode("100755"), "100755");
  assert.equal(padMode(0o100644), "100644");
  assert.equal(padMode(0o100755), "100755");
});

test("single-entry tree has stable hash", () => {
  const h = treeHash([{ mode: "100644", name: "a", oid: blobA, type: "blob" }]);
  assert.match(h, /^[0-9a-f]{40}$/);
  // 同一输入两次必须一致
  assert.equal(h, treeHash([{ mode: "100644", name: "a", oid: blobA, type: "blob" }]));
});
