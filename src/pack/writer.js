// packfile 构建：把一组对象写成 pack + idx。
//
// 有了写入能力，就能做**闭环测试**：自己生成 pack，再用自己的解析器读回来，
// 同时用独立验证器校验。单向只读很难验证正确性，能写能读才能互证。
//
// 简化决策：只写完整对象（不产出 delta），但**能读 delta**。
// 理由：写 delta 需要找相似对象、算最小编辑脚本、处理 delta 链深度，
// 而验证核心格式正确性并不需要——真 Git 生成的 delta pack 由读取端负责。

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export const TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };

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

export function buildPack(objects) {
  // objects: [{type, content}] —— 顺序即 pack 内顺序
  const parts = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);

  const entries = [];
  for (const obj of objects) {
    const content = Buffer.isBuffer(obj.content) ? obj.content : Buffer.from(obj.content, "utf8");
    const offset = parts.reduce((n, b) => n + b.length, 0);
    const objHeader = buildObjectHeader(obj.type, content.length);
    const compressed = deflateSync(content);
    parts.push(objHeader, compressed);

    const sha = computeOid(obj.type, content);
    const crc = crc32(Buffer.concat([objHeader, compressed]));
    entries.push({ sha, offset, crc, type: obj.type, content });
  }

  const body = Buffer.concat(parts);
  const packChecksum = createHash("sha1").update(body).digest();
  const pack = Buffer.concat([body, packChecksum]);

  const idx = buildIdx(entries, packChecksum);
  return { pack, idx, entries, packChecksum: packChecksum.toString("hex") };
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
      // 超大偏移：存下标并置最高位
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
  //
  // 这里曾经写成只覆盖 body，导致与真 git 不一致。
  const withPackChecksum = Buffer.concat([body, packChecksum]);
  const idxChecksum = createHash("sha1").update(withPackChecksum).digest();
  return Buffer.concat([withPackChecksum, idxChecksum]);
}

// CRC32（idx 里用于校验每个对象的压缩数据）。查表法，与 zlib 的 crc32 一致。
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
