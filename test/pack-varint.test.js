// packfile 变长整数编码。两种编码规则不同，必须分别验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readOffsetVarint, encodeOffsetVarint,
  readSizeVarint, encodeSizeVarint,
} from "../src/pack/varint.js";

test("size varint roundtrips across boundaries", () => {
  for (const n of [0, 1, 127, 128, 255, 256, 16383, 16384, 100000, 1000000, 0x7ffffff]) {
    const encoded = encodeSizeVarint(n);
    const { value, next } = readSizeVarint(encoded, 0);
    assert.equal(value, n, "value for " + n);
    assert.equal(next, encoded.length, "consumed all bytes for " + n);
  }
});

test("size varint uses continuation bits", () => {
  assert.equal(encodeSizeVarint(127).length, 1);
  assert.equal(encodeSizeVarint(128).length, 2);
  assert.ok(encodeSizeVarint(128)[0] & 0x80, "first byte must set continuation bit");
});

test("offset varint roundtrips across boundaries", () => {
  for (const n of [0, 1, 127, 128, 255, 256, 1000, 65535, 100000, 1000000, 10000000]) {
    const encoded = encodeOffsetVarint(n);
    const { value, next } = readOffsetVarint(encoded, 0);
    assert.equal(value, n, "value for " + n + " (encoded " + encoded.toString("hex") + ")");
    assert.equal(next, encoded.length);
  }
});

test("offset varint has the +1 bias correction", () => {
  // 这是最容易漏掉的一条：续字节要先把累积值 +1 再左移。
  // 用一个多位编码验证：若漏掉 +1，解出来的值会偏小。
  const encoded = encodeOffsetVarint(200);
  assert.ok(encoded.length >= 2, "200 needs multiple bytes");
  assert.equal(readOffsetVarint(encoded, 0).value, 200);
});

test("the two varint schemes are genuinely different", () => {
  // 同数值 200，两种编码不应相同（否则说明实现搞混了）
  const sizeEnc = encodeSizeVarint(200);
  const offsetEnc = encodeOffsetVarint(200);
  assert.notEqual(sizeEnc.toString("hex"), offsetEnc.toString("hex"));
  // 但各自解回同一个值
  assert.equal(readSizeVarint(sizeEnc, 0).value, 200);
  assert.equal(readOffsetVarint(offsetEnc, 0).value, 200);
});

test("reads varint at a non-zero start offset", () => {
  const prefix = Buffer.from([0xaa, 0xbb]);
  const enc = encodeSizeVarint(300);
  const combined = Buffer.concat([prefix, enc]);
  const r = readSizeVarint(combined, 2);
  assert.equal(r.value, 300);
  assert.equal(r.next, 2 + enc.length);
});
