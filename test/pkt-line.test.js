// pkt-line 帧格式的单元测试。
//
// 帧格式是传输层的地基：长度头差 4 个字节，整个协商就错位。
// 这里逐字节验证编码结果，而不是只看「能解析回来」——
// 往返一致只能证明编码解码互相对称，两边同时错也会通过。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodePktLine,
  flushPkt,
  delimPkt,
  parsePktLines,
  encodeSideband,
  MAX_PAYLOAD,
} from "../src/transport/pkt-line.js";

test("pkt-line: 编码结果的长度头逐字节正确", () => {
  // "hello\n" 是 6 字节，加上 4 字节头 = 10 = 0x000a
  assert.equal(encodePktLine("hello\n").toString("latin1"), "000ahello\n");
  // 空载荷应该只有头 0004
  assert.equal(encodePktLine("").toString("latin1"), "0004");
  // 单字节载荷
  assert.equal(encodePktLine("x").toString("latin1"), "0005x");
});

test("pkt-line: 特殊帧的编码", () => {
  assert.equal(flushPkt().toString("latin1"), "0000");
  assert.equal(delimPkt().toString("latin1"), "0001");
});

test("pkt-line: 长度必须包含 4 字节头", () => {
  // 这是最容易写错的地方：很容易只算载荷长度
  const payload = "a".repeat(100);
  const encoded = encodePktLine(payload);
  const declared = parseInt(encoded.subarray(0, 4).toString("latin1"), 16);
  assert.equal(declared, payload.length + 4);
  assert.equal(encoded.length, declared);
});

test("pkt-line: 解析真实的服务端广告格式", () => {
  // gitee 实际返回的格式（截取）。
  // 长度必须精确计算：4 字节头 + 载荷字节数。
  // 手写常量很容易算错，所以用程序算。
  const svc = "# service=git-upload-pack\n";
  const refLine = "8accea70d7df5356cafa40433d19ee95e52fcd72 HEAD\0multi_ack side-band-64k\n";
  const pkt = (s) => (s.length + 4).toString(16).padStart(4, "0") + s;
  const raw = Buffer.from(pkt(svc) + "0000" + pkt(refLine), "latin1");
  const { packets, rest } = parsePktLines(raw);
  assert.equal(rest.length, 0, "应完整解析");
  assert.equal(packets[0].type, "data");
  assert.equal(packets[0].data.toString(), "# service=git-upload-pack\n");
  assert.equal(packets[1].type, "flush");
  assert.equal(packets[2].type, "data");
  assert.ok(packets[2].data.toString().includes("HEAD"));
});

test("pkt-line: 识别 flush / delim / response-end", () => {
  const raw = Buffer.concat([
    encodePktLine("a"),
    flushPkt(),
    delimPkt(),
    Buffer.from("0002", "latin1"),
    encodePktLine("b"),
  ]);
  const { packets } = parsePktLines(raw);
  assert.deepEqual(packets.map((p) => p.type), ["data", "flush", "delim", "response-end", "data"]);
});

test("pkt-line: 不完整数据返回 rest 而不是抛错", () => {
  const full = encodePktLine("hello world");
  // 截掉最后 3 个字节
  const partial = full.subarray(0, full.length - 3);
  const { packets, rest } = parsePktLines(partial);
  assert.equal(packets.length, 0, "不完整帧不应被解析出来");
  assert.equal(rest.length, full.length - 3, "剩余数据要原样返回");
});

test("pkt-line: 非法长度头抛错", () => {
  const bad = Buffer.from("zzzzhello", "latin1");
  assert.throws(() => parsePktLines(bad), /invalid length header/);
});

test("pkt-line: 超过上限的载荷被拒绝", () => {
  const tooBig = "x".repeat(MAX_PAYLOAD + 1);
  assert.throws(() => encodePktLine(tooBig), /payload too large/);
  // 正好等于上限应该可以
  assert.doesNotThrow(() => encodePktLine("x".repeat(MAX_PAYLOAD)));
});

test("pkt-line: 多帧连续解析", () => {
  const frames = [];
  for (let i = 0; i < 50; i += 1) frames.push(encodePktLine("line " + i + "\n"));
  const raw = Buffer.concat(frames);
  const { packets, rest } = parsePktLines(raw);
  assert.equal(rest.length, 0);
  assert.equal(packets.length, 50);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(packets[i].data.toString(), "line " + i + "\n");
  }
});

test("pkt-line: side-band 分块", () => {
  const data = Buffer.from("x".repeat(MAX_PAYLOAD * 2 + 100));
  const encoded = encodeSideband(1, data);
  const { packets } = parsePktLines(encoded);

  // 每帧首字节应为通道号 1
  let total = 0;
  for (const p of packets) {
    assert.equal(p.data[0], 1, "通道号应为 1（主数据）");
    total += p.data.length - 1;
  }
  assert.equal(total, data.length, "所有分块拼起来应等于原数据");
});

test("pkt-line: 二进制载荷不被破坏", () => {
  // 载荷可能包含 NUL 和任意字节（pack 数据）
  const binary = Buffer.from([0x00, 0xff, 0x50, 0x41, 0x43, 0x4b, 0x0a, 0x00, 0x7f]);
  const encoded = encodePktLine(binary);
  const { packets } = parsePktLines(encoded);
  assert.equal(Buffer.compare(packets[0].data, binary), 0);
});
