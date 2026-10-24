// delta 编码：从一个 base 对象生成「构造目标对象」的指令流。
//
// 这是 packfile 里真正决定体积的部分。写入端如果只存完整对象，
// 生成出来的 pack 会比真 git 大一个数量级——同一文件的历史版本
// 往往只有几十行差异，整存等于每次重复存全文。
//
// 算法：滚动索引 + 贪心最长匹配。
//
//   1. 把 base 切成固定大小的块，用「内容哈希」建索引：hash -> [位置...]
//   2. 在 target 上滑动，当前位置在索引里能找到候选就从该位置向后延伸，
//      量出最长匹配长度
//   3. 匹配足够长就发复制指令，否则累积字面数据、稍后发插入指令
//
// 为什么用「固定块 + 延伸」而不是纯 LCS：delta 的复制指令有 4 字节偏移、
// 3 字节长度的编码开销，复制 7 字节以下根本不省空间。固定块 + 延伸
// 能快速找到长匹配，正好契合这类数据的特征（大段内容不变、局部插入删除）。
//
// 安全性：任何编码结果都必须能被 applyDelta 原样还原，否则宁可退回整存。
// 这一点由 encodeDelta 末尾的自校验强制保证。

import { encodeSizeVarint } from "./varint.js";

// 索引块大小。太小会命中过多候选（O(n^2)），太大则漏掉短匹配。
// 16 是常见取值：一个块至少要有 4 字节的实际收益才值得发复制指令。
const BLOCK = 16;

// 复制指令最小收益长度。低于这个长度直接走插入更省。
const MIN_COPY = 16;

// target 中单个插入指令的最大长度：首字节低 7 位是长度，上限 127。
const MAX_INSERT = 0x7f;

// 计算索引键：把 blockSize 字节映射成一个整数。
// 用简单多项式滚动而不是强哈希——这里只需要均匀分布，
// 而且必须快（每个 base 字节都要过一次）。
function hashBlock(buf, offset, len) {
  let h = 0x811c9dc5;   // FNV-1a 偏移基准
  for (let i = 0; i < len; i += 1) {
    h ^= buf[offset + i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// 为 base 建立 块哈希 -> 位置列表 的索引。
// 同一哈希可能有多个位置（内容重复），保留前若干个足够，
// 全部保留在极端数据（全同字节）下会退化成 O(n^2)。
function buildIndex(base) {
  const index = new Map();
  const maxPos = base.length - BLOCK;
  for (let pos = 0; pos <= maxPos; pos += 1) {
    const h = hashBlock(base, pos, BLOCK);
    let list = index.get(h);
    if (!list) {
      list = [];
      index.set(h, list);
    }
    // 每个哈希最多留 8 个候选：更早的位置匹配长度通常相近，够用
    if (list.length < 8) list.push(pos);
  }
  return index;
}

// 编码复制指令。偏移和长度都按需写字节：
// 首字节 bit0..bit3 指示偏移的 4 个字节是否存在，
// bit4..bit6 指示长度的 3 个字节是否存在。
function encodeCopy(offset, size, out) {
  const bytes = [];
  let cmd = 0x80;

  if (offset & 0xff) { cmd |= 0x01; bytes.push(offset & 0xff); }
  if (offset & 0xff00) { cmd |= 0x02; bytes.push((offset >> 8) & 0xff); }
  if (offset & 0xff0000) { cmd |= 0x04; bytes.push((offset >> 16) & 0xff); }
  if (offset & 0xff000000) { cmd |= 0x08; bytes.push((offset >> 24) & 0xff); }

  // 长度 0x10000 用全零字段表示以省一个字节
  const s = size === 0x10000 ? 0 : size;
  if (s & 0xff) { cmd |= 0x10; bytes.push(s & 0xff); }
  if (s & 0xff00) { cmd |= 0x20; bytes.push((s >> 8) & 0xff); }
  if (s & 0xff0000) { cmd |= 0x40; bytes.push((s >> 16) & 0xff); }

  out.push(cmd, ...bytes);
}

// 把累积的字面数据切成若干插入指令（单条上限 127 字节）
function flushLiteral(literal, out) {
  let pos = 0;
  while (pos < literal.length) {
    const len = Math.min(MAX_INSERT, literal.length - pos);
    out.push(len);
    for (let i = 0; i < len; i += 1) out.push(literal[pos + i]);
    pos += len;
  }
}

// 一份复制指令的最大长度：3 字节长度字段，且 0x10000 有特殊含义，
// 所以单条最多 0xffffff。
const MAX_COPY = 0xffffff;

export function createDelta(base, target) {
  if (base.length === 0) return null;   // 空 base 无法产生有意义的 delta

  const index = buildIndex(base);
  const out = [];
  const literal = [];

  let pos = 0;
  while (pos < target.length) {
    let bestLen = 0;
    let bestOffset = 0;

    // 只有剩余长度够一个块时才查索引
    if (pos + BLOCK <= target.length) {
      const h = hashBlock(target, pos, BLOCK);
      const candidates = index.get(h);
      if (candidates) {
        const maxLeft = target.length - pos;
        for (const cand of candidates) {
          // 从块起点向后延伸
          let len = 0;
          const limit = Math.min(maxLeft, base.length - cand, MAX_COPY);
          while (len < limit && base[cand + len] === target[pos + len]) len += 1;
          if (len > bestLen) {
            bestLen = len;
            bestOffset = cand;
            if (len === maxLeft) break;   // 不可能更长了
          }
        }
      }
    }

    if (bestLen >= MIN_COPY) {
      // 发复制指令前先把累积的字面数据清掉
      if (literal.length > 0) {
        flushLiteral(literal, out);
        literal.length = 0;
      }
      encodeCopy(bestOffset, bestLen, out);
      pos += bestLen;
    } else {
      literal.push(target[pos]);
      pos += 1;
    }
  }

  if (literal.length > 0) flushLiteral(literal, out);

  // 拼装：base 大小 + target 大小 + 指令流
  const head = [
    ...encodeSizeVarint(base.length),
    ...encodeSizeVarint(target.length),
  ];
  return Buffer.from([...head, ...out]);
}

// 带自校验的编码：生成后立刻用 applyDelta 还原一遍，
// 不一致就放弃 delta（返回 null，调用方退回整存）。
//
// 这是必要的防御：delta 编码错一位就会产生「看似成功、内容错乱」的对象，
// 而这种损坏只有等到 checkout 时才会暴露。
export async function createDeltaVerified(base, target) {
  const delta = createDelta(base, target);
  if (!delta) return null;
  const { applyDelta } = await import("./delta.js");
  let restored;
  try {
    restored = applyDelta(base, delta);
  } catch {
    return null;
  }
  if (Buffer.compare(restored, target) !== 0) return null;
  return delta;
}
