// delta 应用。这是 packfile 里最容易出错的部分。

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDelta } from "../src/pack/delta.js";
import { encodeSizeVarint } from "../src/pack/varint.js";

// 构造 delta 的工具：复制/插入指令
function copyCmd(offset, size) {
  let cmd = 0x80;
  const bytes = [];
  if (offset & 0xff || offset === 0 ? true : false) { /* noop */ }
  // offset 按需字节
  const offBytes = [];
  for (let i = 0; i < 4; i += 1) {
    const b = (offset >>> (i * 8)) & 0xff;
    if (b !== 0 || (i === 0 && offset === 0)) { offBytes.push(b); cmd |= 1 << i; }
  }
  const sizeBytes = [];
  for (let i = 0; i < 3; i += 1) {
    const b = (size >>> (i * 8)) & 0xff;
    if (b !== 0 || (i === 0 && size === 0)) { sizeBytes.push(b); cmd |= 1 << (4 + i); }
  }
  // 修正：offset 为 0 时按需字段应全部省略（0 字节表示偏移 0）
  return { cmd, offBytes, sizeBytes };
}

function buildDelta(baseLen, resultLen, instructions) {
  return Buffer.concat([
    encodeSizeVarint(baseLen),
    encodeSizeVarint(resultLen),
    ...instructions,
  ]);
}

// 手工构造：copy(offset, size)
function copy(offset, size) {
  let cmd = 0x80;
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    const b = (offset >>> (i * 8)) & 0xff;
    if (b !== 0) { out.push(b); cmd |= 1 << i; }
  }
  for (let i = 0; i < 3; i += 1) {
    const b = (size >>> (i * 8)) & 0xff;
    if (b !== 0 || (i === 0 && size === 0)) { out.push(b); cmd |= 1 << (4 + i); }
  }
  return Buffer.concat([Buffer.from([cmd]), Buffer.from(out)]);
}

function insert(data) {
  if (data.length > 0x7f) throw new Error("test insert too large");
  return Buffer.concat([Buffer.from([data.length]), data]);
}

test("delta that copies the whole base", () => {
  const base = Buffer.from("abcdefghij");
  const delta = buildDelta(base.length, base.length, [copy(0, base.length)]);
  assert.equal(applyDelta(base, delta).toString(), "abcdefghij");
});

test("delta that inserts only", () => {
  const base = Buffer.from("");
  const delta = buildDelta(0, 5, [insert(Buffer.from("hello"))]);
  assert.equal(applyDelta(base, delta).toString(), "hello");
});

test("delta combining copy and insert", () => {
  const base = Buffer.from("hello world");
  const delta = buildDelta(base.length, 21, [
    copy(0, 6),                              // "hello "
    insert(Buffer.from("beautiful ")),       // "beautiful "
    copy(6, 5),                              // "world"
  ]);
  assert.equal(applyDelta(base, delta).toString(), "hello beautiful world");
});

test("base size mismatch is detected", () => {
  const base = Buffer.from("abc");
  const delta = buildDelta(999, 3, [copy(0, 3)]);
  assert.throws(() => applyDelta(base, delta), /base size mismatch/);
});

test("copy out of range is rejected", () => {
  const base = Buffer.from("abc");
  const delta = buildDelta(3, 100, [copy(0, 100)]);
  assert.throws(() => applyDelta(base, delta), /out of range|overflow/);
});

test("zero command byte is rejected", () => {
  const base = Buffer.from("abc");
  const delta = buildDelta(3, 3, [Buffer.from([0x00])]);
  assert.throws(() => applyDelta(base, delta), /zero command/);
});

test("copy size 0 means 65536 (the special case)", () => {
  // 长度字段全零时表示 0x10000，这个约定忘了就会把大段复制当成 0 长度
  const base = Buffer.alloc(0x10000, 0x41);
  const delta = buildDelta(base.length, 0x10000, [Buffer.from([0x80])]);  // cmd=0x80, 无 offset/size 字节 => offset 0, size 0 => 65536
  const out = applyDelta(base, delta);
  assert.equal(out.length, 0x10000);
  assert.ok(out.every((b) => b === 0x41));
});

test("multiple copies from different offsets", () => {
  const base = Buffer.from("0123456789");
  const delta = buildDelta(base.length, 6, [copy(8, 2), copy(0, 2), copy(4, 2)]);
  assert.equal(applyDelta(base, delta).toString(), "890145");
});
