// 对象层测试。最关键的一条：**哈希必须与真 Git 一致**。
//
// 用已知常量验证：空 blob 的哈希是 Git 世界里最著名的常量之一。
// 如果这条不符，说明头部格式或哈希范围错了。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hashObject, encodeObject, decodeObject } from "../src/objects.js";

test("empty blob hash matches real git", () => {
  // $ git hash-object -t blob /dev/null
  assert.equal(hashObject("blob", ""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("'hello' blob hash matches real git", () => {
  // $ printf 'hello' | git hash-object -t blob --stdin
  assert.equal(hashObject("blob", "hello"), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
});

test("'hello\n' blob hash differs from 'hello' by exactly the newline", () => {
  assert.notEqual(hashObject("blob", "hello"), hashObject("blob", "hello\n"));
  // $ echo hello | git hash-object -t blob --stdin
  assert.equal(hashObject("blob", "hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("empty tree hash matches real git", () => {
  // $ git mktree < /dev/null
  assert.equal(hashObject("tree", ""), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("encode/decode roundtrip preserves type, size and bytes", () => {
  const { raw } = encodeObject("blob", "内容带中文");
  const decoded = decodeObject(raw);
  assert.equal(decoded.type, "blob");
  assert.equal(decoded.content.toString("utf8"), "内容带中文");
});

test("decoded size matches byte length, not char length", () => {
  const text = "中文"; // 6 bytes utf8, 2 chars
  const { raw } = encodeObject("blob", text);
  const decoded = decodeObject(raw);
  assert.equal(decoded.content.length, 6);
});

test("corrupt object is rejected rather than silently accepted", () => {
  const { encodeObject: enc } = { encodeObject };
  const { raw } = enc("blob", "x");
  const truncated = raw.subarray(0, Math.floor(raw.length / 2));
  assert.throws(() => decodeObject(truncated));
});
