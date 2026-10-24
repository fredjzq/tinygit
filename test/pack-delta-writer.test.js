// delta 编码器的单元测试。
//
// 重点不是「能生成 delta」，而是「生成的 delta 一定能被 applyDelta 还原」。
// delta 编码错一位会产生「解压成功但内容错乱」的对象，
// 这种损坏只有等到 checkout 时才暴露，所以每个用例都必须做往返校验。

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDelta } from "../src/pack/delta-writer.js";
import { applyDelta } from "../src/pack/delta.js";

function roundtrip(base, target, label) {
  const delta = createDelta(base, target);
  assert.notEqual(delta, null, label + ": 应生成 delta");
  const restored = applyDelta(base, delta);
  assert.equal(Buffer.compare(restored, target), 0, label + ": 还原内容必须一致");
  return delta;
}

test("delta: base 与 target 完全相同时只产生一条复制指令", () => {
  const base = Buffer.from("abcdefghij".repeat(20));
  const delta = roundtrip(base, Buffer.from(base), "相同内容");
  // base 大小 + target 大小 + 一条复制指令（最多 8 字节）
  assert.ok(delta.length < 20, "delta 应远小于原内容，实际 " + delta.length);
});

test("delta: 末尾追加", () => {
  const base = Buffer.from("hello world ".repeat(30));
  const target = Buffer.from(base.toString() + "TAIL DATA HERE");
  const delta = roundtrip(base, target, "末尾追加");
  assert.ok(delta.length < 40, "只在末尾追加时 delta 应该很小，实际 " + delta.length);
});

test("delta: 开头插入", () => {
  const base = Buffer.from("middle content ".repeat(30));
  const target = Buffer.from("HEAD" + base.toString());
  roundtrip(base, target, "开头插入");
});

test("delta: 中间修改一处", () => {
  const lines = Array.from({ length: 100 }, (_, i) => "line " + i);
  const base = Buffer.from(lines.join("\n"));
  lines[50] = "CHANGED";
  const target = Buffer.from(lines.join("\n"));
  const delta = roundtrip(base, target, "中间改一处");
  // 900 字节的内容只改一行，delta 应远小于原大小
  assert.ok(delta.length < base.length / 4, "delta 应显著小于原内容，实际 " + delta.length);
});

test("delta: 完全无关的内容", () => {
  const base = Buffer.from("aaaa".repeat(200));
  const target = Buffer.from("zzzz".repeat(200));
  // 没有共享内容时 delta 会比原内容更大，这是合法的——
  // 调用方（writer）会判断体积，收益不足就退回整存
  roundtrip(base, target, "无关内容");
});

test("delta: target 为空", () => {
  const base = Buffer.from("something here ".repeat(20));
  const delta = roundtrip(base, Buffer.alloc(0), "空 target");
  assert.ok(delta.length <= 4, "空 target 的 delta 只有两个长度字段");
});

test("delta: 单字节内容", () => {
  roundtrip(Buffer.from("x"), Buffer.from("y"), "单字节");
});

test("delta: 随机二进制内容", () => {
  for (let i = 0; i < 10; i += 1) {
    const base = randomBytes(200 + i * 37);
    const target = randomBytes(200 + i * 41);
    roundtrip(base, target, "随机二进制 #" + i);
  }
});

test("delta: 长距离插入与删除", () => {
  const base = Buffer.from(Array.from({ length: 500 }, (_, i) => "row " + i).join("\n"));
  // 删掉中间一段，再在后面插入一段
  const rows = Array.from({ length: 500 }, (_, i) => "row " + i);
  rows.splice(100, 50);
  rows.push("new row A", "new row B", "new row C");
  const target = Buffer.from(rows.join("\n"));
  roundtrip(base, target, "插入删除混合");
});

test("delta: base 为空时返回 null", () => {
  assert.equal(createDelta(Buffer.alloc(0), Buffer.from("anything")), null);
});

test("delta: 大量历史版本逐对校验", () => {
  // 模拟真实场景：同一文件连续修改
  const lines = Array.from({ length: 200 }, (_, i) => "line " + i + " with content");
  let prev = Buffer.from(lines.join("\n"));
  for (let v = 0; v < 20; v += 1) {
    const mod = [...lines];
    mod[(v * 11) % 200] = "changed at v" + v;
    const cur = Buffer.from(mod.join("\n"));
    roundtrip(prev, cur, "版本 " + v);
    prev = cur;
  }
});
