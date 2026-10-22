// .idx 文件：pack 文件的索引，用于按 sha 快速定位对象。
//
// 格式（version 2）：
//   0   4 字节   魔术 \377tOc
//   4   4 字节   版本号（2）
//   8   256×4 字节 fanout 表：累计计数，用于把 sha 首字节映射到区间
//   1032  N×20     排序后的 sha 列表
//   1032+N*20  N×4   CRC32（每个对象）
//   ...        N×4  偏移表（前 31 位偏移，最高位表示「大偏移表下标」）
//   ...        大偏移表（8 字节每项，仅超大 pack 需要）
//   末尾 40 字节：idx 校验和 + pack 校验和
//
// fanout 表是性能关键：查某个 sha 时，用首字节直接查出区间，
// 只需在该区间内二分，而不是全表二分。

export const IDX_MAGIC = 0xff744f63;

export function parseIdx(buf) {
  if (buf.length < 1032) throw new Error("idx: file too short");
  const magic = buf.readUInt32BE(0);
  if (magic !== IDX_MAGIC) throw new Error("idx: bad magic (not a v2 idx file)");
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error("idx: unsupported version " + version);

  const fanout = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) fanout[i] = buf.readUInt32BE(8 + i * 4);
  const count = fanout[255];

  const shaStart = 8 + 256 * 4;
  const crcStart = shaStart + count * 20;
  const offStart = crcStart + count * 4;
  const largeStart = offStart + count * 4;

  const shas = new Array(count);
  const offsets = new Float64Array(count);  // 用 double 存 64 位偏移，避免精度问题
  const crcs = new Uint32Array(count);

  let largeCount = 0;
  for (let i = 0; i < count; i += 1) {
    shas[i] = buf.subarray(shaStart + i * 20, shaStart + i * 20 + 20).toString("hex");
    crcs[i] = buf.readUInt32BE(crcStart + i * 4);

    const rawOff = buf.readUInt32BE(offStart + i * 4);
    if (rawOff & 0x80000000) {
      // 高位为 1：低 31 位是大偏移表的下标
      const largeIdx = rawOff & 0x7fffffff;
      const pos = largeStart + largeIdx * 8;
      if (pos + 8 > buf.length - 40) throw new Error("idx: large offset out of range");
      // 64 位偏移拆成高低 32 位读，避免 BigInt 转换开销
      const hi = buf.readUInt32BE(pos);
      const lo = buf.readUInt32BE(pos + 4);
      offsets[i] = hi * 0x100000000 + lo;
      largeCount += 1;
    } else {
      offsets[i] = rawOff;
    }
  }

  // 末尾 40 字节的顺序（容易搞反，实测确认）：
  //   [len-40, len-20) = pack 文件内容的 sha1
  //   [len-20, len)    = idx 文件自身（前 len-20 字节）的 sha1
  // pack 文件名就是 pack 校验和，可用来交叉验证。
  const packChecksum = buf.subarray(buf.length - 40, buf.length - 20).toString("hex");
  const idxChecksum = buf.subarray(buf.length - 20).toString("hex");

  return { version, count, fanout, shas, offsets, crcs, idxChecksum, packChecksum, largeCount };
}

// 用 fanout 表把查找范围缩到某个首字节的区间
export function fanoutRange(fanout, firstByte) {
  const lo = firstByte === 0 ? 0 : fanout[firstByte - 1];
  const hi = fanout[firstByte];
  return [lo, hi];
}

export function findOffset(idx, shaHex) {
  const firstByte = parseInt(shaHex.slice(0, 2), 16);
  const [lo, hi] = fanoutRange(idx.fanout, firstByte);
  // 区间内二分（sha 列表是字典序）
  let left = lo;
  let right = hi - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const cmp = idx.shas[mid].localeCompare(shaHex);
    if (cmp === 0) return { found: true, offset: idx.offsets[mid], index: mid };
    if (cmp < 0) left = mid + 1;
    else right = mid - 1;
  }
  return { found: false };
}

// 验证 idx 自身校验和：覆盖 [0, len-40) 的 body，不含 pack 校验和。
export function verifyIdxChecksum(buf) {
  const { createHash } = require("node:crypto");
  const expected = buf.subarray(buf.length - 20).toString("hex");
  const actual = createHash("sha1").update(buf.subarray(0, buf.length - 40)).digest("hex");
  return { ok: expected === actual, expected, actual };
}
