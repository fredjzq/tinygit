// delta 应用算法：packfile 里绝大多数对象都以 delta 形式存储。
//
// delta 由两段指令组成：
//   1. base 大小（varint）
//   2. result 大小（varint）
//   3. 指令流，每条以首字节高位区分：
//      - 高位 1xxxxxxx → 复制指令：从 base 的某个位置复制若干字节
//      - 高位 00000000 → 插入指令：后面 N 字节是字面数据
//      - 全 0 字节 → 保留，非法（大小为 0 的指令无意义）
//
// 复制指令的偏移和长度都是「按需字段」：首字节的各个位分别指示
// 对应的字节是否存在。这是紧凑编码，但也最容易写错——
// 少判一位就会把偏移读错，产生看似成功实则错乱的内容。

import { readSizeVarint } from "./varint.js";

export function applyDelta(base, delta) {
  const baseSize = readSizeVarint(delta, 0);
  const expectedBaseSize = baseSize.value;

  if (base.length !== expectedBaseSize) {
    // 这条检查很有价值：它能在 delta 链错位时立刻暴露问题，
    // 而不是等应用完产生一段垃圾内容。
    throw new Error(
      "delta: base size mismatch (delta says " + expectedBaseSize + ", actual " + base.length + ")"
    );
  }

  const resultSize = readSizeVarint(delta, baseSize.next);
  let pos = resultSize.next;
  const out = Buffer.allocUnsafe(resultSize.value);
  let outPos = 0;

  while (pos < delta.length) {
    const cmd = delta[pos];
    pos += 1;

    if (cmd === 0) {
      throw new Error("delta: unexpected zero command byte");
    }

    if (cmd & 0x80) {
      // ---- 复制指令 ----
      let offset = 0;
      let size = 0;

      // 偏移：4 个可选字节，对应首字节的 bit0..bit3
      if (cmd & 0x01) { offset |= delta[pos]; pos += 1; }
      if (cmd & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (cmd & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (cmd & 0x08) { offset |= delta[pos] << 24; pos += 1; }

      // 长度：3 个可选字节，对应 bit4..bit6
      if (cmd & 0x10) { size |= delta[pos]; pos += 1; }
      if (cmd & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (cmd & 0x40) { size |= delta[pos] << 16; pos += 1; }

      // 特例：长度全零表示 0x10000（65536）。这是为了省字节的约定，
      // 忘了它会导致大段复制的长度被当成 0。
      if (size === 0) size = 0x10000;

      if (offset + size > base.length) {
        throw new Error("delta: copy out of range (offset " + offset + " size " + size + " base " + base.length + ")");
      }
      if (outPos + size > out.length) {
        throw new Error("delta: result overflow");
      }
      base.copy(out, outPos, offset, offset + size);
      outPos += size;
    } else {
      // ---- 插入指令 ----
      const size = cmd;  // 低 7 位就是长度（此时高位为 0）
      if (pos + size > delta.length) throw new Error("delta: insert out of range");
      if (outPos + size > out.length) throw new Error("delta: result overflow");
      delta.copy(out, outPos, pos, pos + size);
      pos += size;
      outPos += size;
    }
  }

  if (outPos !== resultSize.value) {
    throw new Error("delta: produced " + outPos + " bytes, expected " + resultSize.value);
  }
  return out;
}
