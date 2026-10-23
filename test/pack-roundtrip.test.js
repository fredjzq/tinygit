// pack 写入 → 读取闭环。能写也能读，才能互相验证。
//
// 单向只读测试的弱点：解析器错了但没人知道。
// 闭环测试的强项：写出的 pack 再读回来，内容必须逐一相等。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPack, buildIdx, computeOid, crc32 } from "../src/pack/writer.js";
import { parsePack, parsePackHeader, resolvePackObjects, readObjectHeader } from "../src/pack/reader.js";
import { parseIdx, findOffset, fanoutRange } from "../src/pack/idx.js";

test("pack header is well-formed", () => {
  const { pack } = buildPack([{ type: "blob", content: "x" }]);
  const h = parsePackHeader(pack);
  assert.equal(h.version, 2);
  assert.equal(h.count, 1);
  assert.equal(pack.subarray(0, 4).toString("latin1"), "PACK");
});

test("objects roundtrip with identical content and oid", () => {
  const objects = [
    { type: "blob", content: "" },
    { type: "blob", content: "hello\n" },
    { type: "blob", content: "x".repeat(10000) },
    { type: "tree", content: Buffer.alloc(0) },
    { type: "blob", content: Buffer.from([0, 1, 2, 253, 254, 255]) },
  ];
  const { pack, entries } = buildPack(objects);
  const resolved = resolvePackObjects(pack);

  assert.equal(resolved.byOid.size, objects.length);
  for (const e of entries) {
    const got = resolved.byOid.get(e.sha);
    assert.ok(got, "missing object " + e.sha);
    assert.equal(got.type, e.type);
    assert.equal(Buffer.compare(got.content, e.content), 0, "content mismatch for " + e.sha.slice(0, 8));
  }
});

test("empty blob inside a pack keeps the canonical oid", () => {
  const { entries } = buildPack([{ type: "blob", content: "" }]);
  assert.equal(entries[0].sha, "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("empty tree inside a pack keeps the canonical oid", () => {
  const { entries } = buildPack([{ type: "tree", content: Buffer.alloc(0) }]);
  assert.equal(entries[0].sha, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("pack trailer is the sha1 of everything before it", async () => {
  const { createHash } = await import("node:crypto");
  const { pack } = buildPack([{ type: "blob", content: "abc" }]);
  const expected = createHash("sha1").update(pack.subarray(0, pack.length - 20)).digest("hex");
  assert.equal(pack.subarray(pack.length - 20).toString("hex"), expected);
});

test("idx fanout table is monotonic and ends at the object count", () => {
  const objects = Array.from({ length: 30 }, (_, i) => ({ type: "blob", content: "obj" + i }));
  const { idx, entries } = buildPack(objects);
  const parsed = parseIdx(idx);
  assert.equal(parsed.count, entries.length);

  let prev = 0;
  for (let i = 0; i < 256; i += 1) {
    assert.ok(parsed.fanout[i] >= prev, "fanout must be non-decreasing at " + i);
    prev = parsed.fanout[i];
  }
  assert.equal(parsed.fanout[255], entries.length);
});

test("idx shas are sorted, as required for binary search", () => {
  const objects = Array.from({ length: 40 }, (_, i) => ({ type: "blob", content: "item-" + i }));
  const { idx } = buildPack(objects);
  const parsed = parseIdx(idx);
  const sorted = [...parsed.shas].sort();
  assert.deepEqual(parsed.shas, sorted);
});

test("every object can be located via idx", () => {
  const objects = Array.from({ length: 50 }, (_, i) => ({ type: "blob", content: "payload " + i }));
  const { pack, idx, entries } = buildPack(objects);
  const parsed = parseIdx(idx);

  for (const e of entries) {
    const found = findOffset(parsed, e.sha);
    assert.ok(found.found, "idx lookup failed for " + e.sha.slice(0, 8));
    assert.equal(found.offset, e.offset);

    // 偏移确实指向该对象
    const header = readObjectHeader(pack, found.offset);
    assert.equal(header.typeName, e.type);
  }
});

test("idx lookup for a non-existent sha reports not found", () => {
  const { idx } = buildPack([{ type: "blob", content: "only one" }]);
  const parsed = parseIdx(idx);
  const r = findOffset(parsed, "0".repeat(40));
  assert.equal(r.found, false);
});

test("fanoutRange narrows to the first-byte bucket", () => {
  const objects = Array.from({ length: 20 }, (_, i) => ({ type: "blob", content: "n" + i }));
  const { idx, entries } = buildPack(objects);
  const parsed = parseIdx(idx);
  for (const e of entries) {
    const firstByte = parseInt(e.sha.slice(0, 2), 16);
    const [lo, hi] = fanoutRange(parsed.fanout, firstByte);
    const pos = parsed.shas.indexOf(e.sha);
    assert.ok(pos >= lo && pos < hi, "sha must fall inside its fanout bucket");
  }
});

test("idx trailer holds pack checksum then idx checksum", async () => {
  const { createHash } = await import("node:crypto");
  const { idx, packChecksum } = buildPack([{ type: "blob", content: "z" }]);
  const parsed = parseIdx(idx);
  assert.equal(parsed.packChecksum, packChecksum);

  // idx 自身校验和覆盖 [0, len-20)，即包含前面的 pack 校验和
  const body = idx.subarray(0, idx.length - 20);
  assert.equal(parsed.idxChecksum, createHash("sha1").update(body).digest("hex"));
});

test("verifyIdxChecksum accepts our own idx output", async () => {
  const { verifyIdxChecksum } = await import("../src/pack/idx.js");
  const { idx } = buildPack([
    { type: "blob", content: "a" },
    { type: "blob", content: "b".repeat(1000) },
  ]);
  const r = verifyIdxChecksum(idx);
  assert.equal(r.ok, true, "our idx must satisfy the same rule git uses");
});

test("idx self-checksum covers the pack checksum (git semantics)", async () => {
  const { createHash } = await import("node:crypto");
  const { idx } = buildPack([{ type: "blob", content: "semantics" }]);

  // 覆盖 [0, len-20)：包含 pack 校验和
  const covering = createHash("sha1").update(idx.subarray(0, idx.length - 20)).digest("hex");
  // 只覆盖 [0, len-40)：不含 pack 校验和
  const notCovering = createHash("sha1").update(idx.subarray(0, idx.length - 40)).digest("hex");

  const trailer = idx.subarray(idx.length - 20).toString("hex");
  assert.equal(trailer, covering, "trailer must be sha1 over everything except itself");
  assert.notEqual(trailer, notCovering, "trailer must NOT exclude the pack checksum");
});

test("crc32 matches the zlib definition", () => {
  // zlib 的 crc32("hello") 是 0x3610a686
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("large objects survive the roundtrip", () => {
  const big = Buffer.alloc(200000);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
  const { pack, entries } = buildPack([{ type: "blob", content: big }]);
  const resolved = resolvePackObjects(pack);
  const got = resolved.byOid.get(entries[0].sha);
  assert.ok(got);
  assert.equal(got.content.length, big.length);
  assert.equal(Buffer.compare(got.content, big), 0);
});
