// 索引二进制格式。字节布局错了真 Git 会拒绝打开仓库。

import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeIndex, parseIndex, emptyIndex } from "../src/index-file.js";
import { createHash } from "node:crypto";

function makeIndex(paths) {
  return {
    version: 2,
    entries: paths.map((p, i) => ({
      path: p,
      oid: String(i + 1).repeat(40).slice(0, 40),
      mode: parseInt("100644", 8),
      stage: 0,
      stat: { ctime: 1, ctimeNano: 0, mtime: 2, mtimeNano: 0, dev: 3, ino: 4, uid: 0, gid: 0, size: 5 },
    })),
  };
}

test("index starts with DIRC signature", () => {
  const buf = serializeIndex(emptyIndex());
  assert.equal(buf.subarray(0, 4).toString("latin1"), "DIRC");
  assert.equal(buf.readUInt32BE(4), 2);
  assert.equal(buf.readUInt32BE(8), 0);
});

test("trailing 20 bytes are the sha1 checksum of the body", () => {
  const buf = serializeIndex(makeIndex(["a.txt"]));
  const body = buf.subarray(0, buf.length - 20);
  const checksum = buf.subarray(buf.length - 20);
  assert.equal(createHash("sha1").update(body).digest("hex"), checksum.toString("hex"));
});

test("parseIndex roundtrips serializeIndex", () => {
  const original = makeIndex(["a.txt", "b/c.txt", "z.txt"]);
  const parsed = parseIndex(serializeIndex(original));
  assert.equal(parsed.entries.length, 3);
  // 索引内部按路径字节序排序
  assert.deepEqual(parsed.entries.map((e) => e.path), ["a.txt", "b/c.txt", "z.txt"]);
  for (const e of parsed.entries) {
    const src = original.entries.find((o) => o.path === e.path);
    assert.equal(e.oid, src.oid);
    assert.equal(e.mode, src.mode);
  }
});

test("entries are padded to an 8-byte boundary", () => {
  for (const name of ["a", "ab", "abcdef", "abcdefghij"]) {
    const buf = serializeIndex(makeIndex([name]));
    const entryStart = 12;
    const nameLen = Buffer.byteLength(name, "utf8");
    const expected = (62 + nameLen + 8) & ~7;
    assert.equal(buf.length - 20 - entryStart, expected, "entry length for " + name);
  }
});

test("bad signature is rejected", () => {
  const buf = Buffer.alloc(32);
  buf.write("XXXX", 0, "latin1");
  assert.throws(() => parseIndex(buf), /bad signature/);
});

test("empty index has zero entries", () => {
  const parsed = parseIndex(serializeIndex(emptyIndex()));
  assert.deepEqual(parsed.entries, []);
});
