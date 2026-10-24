// packfile 构建：把一组对象写成 pack + idx。
//
// 有了写入能力，就能做**闭环测试**：自己生成 pack，再用自己的解析器读回来，
// 同时用独立验证器校验。单向只读很难验证正确性，能写能读才能互证。
//
// 支持两种存储方式：
//   - 完整对象（类型 1/2/3/4），内容直接 zlib 压缩
//   - OFS_DELTA（类型 6），存「相对某个更早对象的增量」
//
// delta 的收益来自同一文件的历史版本：往往只有几十行差异，
// 整存等于每次重复存全文。收益不抵开销时坚决退回整存——
// 复制指令本身就有 1-8 字节的编码开销。

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createDelta } from "./delta-writer.js";
import { applyDelta } from "./delta.js";

export const TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };

// pack 对象类型编号
const T_OFS_DELTA = 6;

export function buildObjectHeader(type, size) {
  const bytes = [];
  let remaining = size;
  let byte = (TYPE_NUM[type] << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

// delta 对象头：类型 6，size 字段是「delta 数据本身」的长度
function buildDeltaHeader(size) {
  const bytes = [];
  let remaining = size;
  let byte = (T_OFS_DELTA << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

// OFS_DELTA 的 base 偏移编码：与普通 size varint 不同，这里每字节有 +1 修正。
// 漏掉修正会读到错误的 base，产生「成功但内容错乱」的对象。
export function encodeOfsDeltaBase(distance) {
  if (distance <= 0) throw new Error("ofs-delta distance must be positive");
  const bytes = [distance & 0x7f];
  let d = distance >>> 7;
  while (d > 0) {
    d -= 1;
    bytes.unshift(0x80 | (d & 0x7f));
    d >>>= 7;
  }
  return Buffer.from(bytes);
}

// 选择 delta 的 base。
//
// 真 git 用滑动窗口 + 按大小/路径排序找候选，这里用更直接的启发：
// 同一类型里找长度最接近的若干个对象试算。对「同一文件的历史版本」
// 这个策略很有效——它们的长度通常接近。
//
// 只尝试有限个候选：delta 编码本身有成本（建索引 + 每个 target 字节过一遍），
// 全量两两比较是 O(n^2)，大仓库会慢到不可用。
// delta 编码的成本是 O(base + target)，所以不能对所有候选都试一遍。
// 策略：按长度接近度排序，只试前几个，且一旦收益足够好就停止。
const MAX_CANDIDATES = 4;
const GOOD_ENOUGH = 0.5;   // delta 小于整存的 50% 就不再看其它候选

function pickCandidates(type, targetLen, existing) {
  const same = [];
  for (const e of existing) {
    if (e.type !== type || e.content.length === 0) continue;
    // 长度比超过 2 倍的候选几乎不可能有长匹配，直接排除（省掉大量无用的建索引开销）
    const ratio = e.content.length > targetLen
      ? e.content.length / targetLen
      : targetLen / e.content.length;
    if (ratio > 2) continue;
    same.push({ e, diff: Math.abs(e.content.length - targetLen) });
  }
  if (same.length === 0) return [];
  return same.sort((a, b) => a.diff - b.diff).slice(0, MAX_CANDIDATES).map((x) => x.e);
}

export function buildPack(objects, options = {}) {
  const useDelta = options.delta !== false;

  const parts = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);

  const entries = [];
  let currentOffset = 12;

  // 已写入的对象，供后续对象寻找 delta base
  const written = [];

  for (const obj of objects) {
    const content = Buffer.isBuffer(obj.content) ? obj.content : Buffer.from(obj.content, "utf8");
    const sha = computeOid(obj.type, content);

    let entry = null;

    if (useDelta) {
      entry = tryDelta(obj.type, content, written, currentOffset);
    }

    if (entry) {
      parts.push(entry.bytes);
      entries.push({
        sha,
        offset: currentOffset,
        crc: 0,   // 稍后统一算
        type: obj.type,
        content,
        delta: true,
        bytes: entry.bytes,
      });
      currentOffset += entry.bytes.length;
    } else {
      const objHeader = buildObjectHeader(obj.type, content.length);
      const compressed = deflateSync(content);
      const bytes = Buffer.concat([objHeader, compressed]);
      parts.push(bytes);
      entries.push({
        sha,
        offset: currentOffset,
        crc: 0,
        type: obj.type,
        content,
        delta: false,
        bytes,
      });
      currentOffset += bytes.length;
    }

    written.push({ type: obj.type, content, offset: entries[entries.length - 1].offset });
  }

  // 统一计算 CRC（idx 要求覆盖每个对象的完整压缩数据）
  for (const e of entries) e.crc = crc32(e.bytes);
  for (const e of entries) delete e.bytes;

  const body = Buffer.concat(parts);
  const packChecksum = createHash("sha1").update(body).digest();
  const pack = Buffer.concat([body, packChecksum]);

  const idx = buildIdx(entries, packChecksum);
  return { pack, idx, entries, packChecksum: packChecksum.toString("hex") };
}

// 尝试为对象生成 delta。返回 {bytes} 或 null（不省空间/无法生成）。
function tryDelta(type, content, written, currentOffset) {
  // 小对象不值得 delta：复制指令的编码开销会吃掉收益
  if (content.length < 64) return null;

  const candidates = pickCandidates(type, content.length, written);
  if (candidates.length === 0) return null;
  const plainSize = deflateSync(content).length + 2;
  let best = null;

  for (const cand of candidates) {
    const distance = currentOffset - cand.offset;
    if (distance <= 0) continue;

    const delta = createDeltaSync(cand.content, content);
    if (!delta) continue;

    const header = buildDeltaHeader(delta.length);
    const baseHeader = encodeOfsDeltaBase(distance);
    const compressed = deflateSync(delta);
    const bytes = Buffer.concat([header, baseHeader, compressed]);

    // 只有确实比整存小才采用（留 10% 余量，避免为微小收益付出复杂度）
    if (bytes.length >= plainSize * 0.9) continue;

    if (!best || bytes.length < best.bytes.length) {
      best = { bytes, base: cand, plain: plainSize };
      // 收益已经很好，没必要再试其它候选
      if (bytes.length < plainSize * GOOD_ENOUGH) break;
    }
  }

  return best;
}

// 同步版 delta 生成（含自校验）。createDeltaVerified 是 async 只因为动态 import，
// 这里直接同步实现，避免 buildPack 变成 async。
function createDeltaSync(base, target) {
  const delta = createDelta(base, target);
  if (!delta) return null;
  try {
    const restored = applyDelta(base, delta);
    if (Buffer.compare(restored, target) !== 0) return null;
  } catch {
    return null;
  }
  return delta;
}

export function computeOid(type, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const header = Buffer.from(type + " " + buf.length + "\0", "latin1");
  return createHash("sha1").update(header).update(buf).digest("hex");
}

// idx v2 构建。必须是「按 sha 排序」的顺序，fanout 才能正确。
export function buildIdx(entries, packChecksum) {
  const sorted = [...entries].sort((a, b) => a.sha.localeCompare(b.sha));
  const count = sorted.length;

  const fanout = Buffer.alloc(256 * 4);
  const counts = new Uint32Array(256);
  for (const e of sorted) counts[parseInt(e.sha.slice(0, 2), 16)] += 1;
  let running = 0;
  for (let i = 0; i < 256; i += 1) {
    running += counts[i];
    fanout.writeUInt32BE(running, i * 4);
  }

  const shaTable = Buffer.alloc(count * 20);
  const crcTable = Buffer.alloc(count * 4);
  const offTable = Buffer.alloc(count * 4);
  const largeOffsets = [];

  for (let i = 0; i < count; i += 1) {
    const e = sorted[i];
    Buffer.from(e.sha, "hex").copy(shaTable, i * 20);
    crcTable.writeUInt32BE(e.crc >>> 0, i * 4);
    if (e.offset < 0x80000000) {
      offTable.writeUInt32BE(e.offset, i * 4);
    } else {
      const largeIdx = largeOffsets.length;
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64BE(BigInt(e.offset));
      largeOffsets.push(buf);
      offTable.writeUInt32BE(0x80000000 | largeIdx, i * 4);
    }
  }

  const head = Buffer.alloc(8);
  head.writeUInt32BE(0xff744f63, 0);
  head.writeUInt32BE(2, 4);

  const body = Buffer.concat([head, fanout, shaTable, crcTable, offTable, ...largeOffsets]);
  // 尾部结构（与真 git 逐字节一致，用 3513 对象的真实 idx 验证过）：
  //   body              ← 索引主体
  //   packChecksum (20) ← pack 文件内容的 sha1（等于 pack 文件名里的 sha）
  //   idxChecksum  (20) ← sha1(body + packChecksum)，**包含** pack 校验和
  const withPackChecksum = Buffer.concat([body, packChecksum]);
  const idxChecksum = createHash("sha1").update(withPackChecksum).digest();
  return Buffer.concat([withPackChecksum, idxChecksum]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
