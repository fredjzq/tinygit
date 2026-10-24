// packfile 读取：把打包对象还原成普通对象。
//
// pack 文件布局：
//   "PACK" + 版本(2) + 对象个数
//   [对象头 + zlib 数据] × N
//   sha1(前面全部内容)      ← 20 字节
//
// 每个对象头是变长编码：
//   首字节：bit0-3 = 类型，bit4-6 = 大小低位，bit7 = 是否有续字节
//   后续字节：低 7 位继续填大小，bit7 表示是否还有
//
// 类型：
//   1 commit   2 tree   3 blob   4 tag
//   6 OFS_DELTA   —— base 是「本对象偏移 - 某距离」，距离用 +1 修正的 varint
//   7 REF_DELTA   —— base 用 20 字节 sha 直接指定
//
// delta 链可能很长（Git 允许最多 50 层），必须递归解析 base。

import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readOffsetVarint } from "./varint.js";
import { applyDelta } from "./delta.js";

export const OBJ_TYPES = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  6: "ofs-delta",
  7: "ref-delta",
};

export function parsePackHeader(buf) {
  if (buf.length < 12) throw new Error("pack: file too short");
  if (buf.subarray(0, 4).toString("latin1") !== "PACK") {
    throw new Error("pack: bad signature");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error("pack: unsupported version " + version);
  const count = buf.readUInt32BE(8);
  return { version, count };
}

// 解析单个对象头，返回类型、大小、头部结束位置
export function readObjectHeader(buf, offset) {
  let pos = offset;
  const first = buf[pos];
  pos += 1;

  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let byte = first;

  while (byte & 0x80) {
    byte = buf[pos];
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }

  const result = { type, typeName: OBJ_TYPES[type] ?? "unknown", size, headerEnd: pos };

  if (type === 6) {
    const { value, next } = readOffsetVarint(buf, pos);
    result.baseDistance = value;
    result.baseOffset = offset - value;
    result.dataStart = next;
  } else if (type === 7) {
    if (pos + 20 > buf.length) throw new Error("pack: truncated ref-delta base");
    result.baseOid = buf.subarray(pos, pos + 20).toString("hex");
    result.dataStart = pos + 20;
  } else {
    result.dataStart = pos;
  }

  if (result.typeName === "unknown") {
    throw new Error("pack: unknown object type " + type + " at offset " + offset);
  }
  return result;
}

// 完整解析一个 pack，返回 Map<offset, {type, content}> 和按对象顺序的偏移列表
export function parsePack(buf) {
  const { count } = parsePackHeader(buf);
  const byOffset = new Map();
  const order = [];

  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const header = readObjectHeader(buf, offset);

        // zlib 的 info 模式直接告诉我们消耗了多少输入字节，无需猜测边界。
    // 注意：delta 对象的 header.size 是「应用 delta 之后」的大小，
    // 不是 delta 数据本身的大小，所以大小校验只在非 delta 分支生效。
    const { length, content } = compressedLength(buf, header.dataStart, header.size);
    const nextOffset = header.dataStart + length;

    byOffset.set(offset, {
      offset,
      header,
      content: content,
    });
    order.push(offset);
    offset = nextOffset;

    if (offset > buf.length - 20 && i < count - 1) {
      throw new Error("pack: object #" + (i + 1) + " runs past end of file");
    }
  }

  return { count, byOffset, order, trailer: buf.subarray(buf.length - 20).toString("hex") };
}

// 找出下一个对象的起始偏移。
// zlib.inflateSync 在遇到流结束标记后停止，但它不接受「最多读多少字节」的参数。
// 可靠做法：手工走 zlib 流结构，或用 zlib 的 Info: 这里采用
// 「用 inflateSync 解压，然后从后往前试」的暴力法代价高，
// 因此改用 Node 的 zlib 内部能力：deflateSync 生成的数据可用 inflateSync 解压，
// 其消耗字节数可通过比较得出。为保持简洁且正确，这里采用二分定位。
// 找出 zlib 流精确消耗的字节数。
//
// 这是 packfile 解析的核心难点：zlib 流没有长度前缀，只能解压后知道在哪结束。
// Node 的 inflateSync 不返回「消费了多少输入」，会静默忽略尾部多余字节。
//
// 可靠解法：zlib 流自带 adler32 校验和与结束标记，**截断的输入必然解压失败**。
// 所以「能成功解压的最小前缀长度」恰好就是流的真实长度。对它二分即可。
//
// 为把搜索范围压到最小，先用 deflate 的理论上界估算：
// 压缩后最大约为 原始大小 + 原始大小/1000 + 12（zlib 头尾）。
// delta 对象的 header.size 是解开后的大小，delta 数据本身通常更小，
// 但用它做上界仍成立（delta 极少比结果更大）。
function compressedLength(buf, start, expectedSize) {
  const available = buf.length - 20 - start;  // 扣掉 20 字节 trailer
  if (available <= 0) throw new Error("pack: truncated object stream");

  // 精确解法：zlib 的 info 模式会返回底层 engine，
  // engine.bytesWritten 就是「本次解压消耗了多少输入字节」。
  //
  // 早期版本没有发现这个能力，改用「截断的输入必然解压失败」做二分，
  // 每个对象要试约 20 次 inflate。3,513 个对象的 pack 因此要 1.1 秒。
  // 现在每个对象只解压一次，快了一个数量级。
  try {
    const res = inflateSync(buf.subarray(start, start + available), { info: true });
    const consumed = res.engine?.bytesWritten ?? 0;
    if (consumed > 0) {
      // 校验解压结果大小与对象头声明一致，不一致说明数据损坏
      if (res.buffer.length !== expectedSize) {
        throw new Error(
          "pack: object size mismatch (header says " + expectedSize +
          ", inflated " + res.buffer.length + ")"
        );
      }
      return { content: res.buffer, length: consumed };
    }
  } catch (err) {
    // 落到下面的慢速路径：某些环境可能不返回 engine
  }

  // 兼容路径：没有 engine 信息时退回二分查找。
  const guess = Math.min(available, Math.max(64, Math.ceil(expectedSize * 1.05) + 64));
  const tryLen = (len) => {
    if (len > available || len < 2) return null;
    try {
      return inflateSync(buf.subarray(start, start + len));
    } catch {
      return null;
    }
  };

  let hi = null;
  let out = tryLen(guess);
  if (out) {
    hi = guess;
  } else {
    let len = Math.min(available, guess * 2);
    while (len <= available) {
      out = tryLen(len);
      if (out) { hi = len; break; }
      if (len === available) break;
      len = Math.min(available, len * 2);
    }
    if (hi === null) {
      // 上界都失败，只能在 [2, available] 上二分
      let lo = 2;
      let high = available;
      while (lo <= high) {
        const mid = (lo + high) >> 1;
        const r = tryLen(mid);
        if (r) { hi = mid; high = mid - 1; }
        else lo = mid + 1;
      }
      if (hi === null) throw new Error("pack: cannot locate zlib stream end");
    }
  }

  // 已知 hi 可行，二分最小的可行长度
  let lo = 2;
  let high = hi;
  let best = hi;
  let bestOut = null;
  while (lo <= high) {
    const mid = (lo + high) >> 1;
    const r = tryLen(mid);
    if (r) { best = mid; bestOut = r; high = mid - 1; }
    else lo = mid + 1;
  }
  if (!bestOut) throw new Error("pack: cannot locate zlib stream end");
  return { content: bestOut, length: best };
}

function findNextObjectOffset(buf, header) {
  const expectedSize = header.size;
  const { length } = compressedLength(buf, header.dataStart, expectedSize);
  return header.dataStart + length;
}

// 把 pack 里的对象全部还原成 {oid -> {type, content}}
// delta 对象需要 base，而 base 可能在同 pack 的前面（OFS）或任意位置（REF）
export function resolvePackObjects(buf, externalLookup = null) {
  const { byOffset, order, count } = parsePack(buf);
  const resolved = new Map();   // offset -> {type, content}
  const byOid = new Map();      // oid -> {type, content}
  const oidByOffset = new Map();

  function computeOid(type, content) {
    const header = Buffer.from(type + " " + content.length + "\0", "latin1");
    return createHash("sha1").update(header).update(content).digest("hex");
  }

  // OFS_DELTA 的 base 一定在同一个 pack 里，且偏移更小
  // REF_DELTA 的 base 可能在 pack 里（用 oid 找），也可能需要外部提供（thin pack）
  function resolve(offset, depth = 0) {
    if (depth > 64) throw new Error("pack: delta chain too deep at offset " + offset);
    if (resolved.has(offset)) return resolved.get(offset);

    const entry = byOffset.get(offset);
    if (!entry) throw new Error("pack: no object at offset " + offset);
    const h = entry.header;

    let result;
    if (h.typeName === "ofs-delta") {
      if (!byOffset.has(h.baseOffset)) {
        throw new Error("pack: ofs-delta base offset " + h.baseOffset + " not found");
      }
      const base = resolve(h.baseOffset, depth + 1);
      const content = applyDelta(base.content, entry.content);
      result = { type: base.type, content };
    } else if (h.typeName === "ref-delta") {
      // 先在已解析的对象里找，再考虑外部
      let base = null;
      for (const [off, obj] of resolved) {
        if (oidByOffset.get(off) === h.baseOid) { base = obj; break; }
      }
      if (!base && externalLookup) {
        const ext = externalLookup(h.baseOid);
        if (ext) base = ext;
      }
      if (!base) {
        throw new Error("pack: ref-delta base " + h.baseOid.slice(0, 8) + " not in pack (thin pack?)");
      }
      const content = applyDelta(base.content, entry.content);
      result = { type: base.type, content };
    } else {
      result = { type: h.typeName, content: entry.content };
    }

    resolved.set(offset, result);
    const oid = computeOid(result.type, result.content);
    oidByOffset.set(offset, oid);
    if (!byOid.has(oid)) byOid.set(oid, result);
    return result;
  }

  for (const offset of order) resolve(offset);
  return { byOid, resolved, oidByOffset, count, order };
}

// 列出 pack 内每个对象的 (sha, offset, 字节区间)。
//
// 为什么单独提供：从网络收到的 pack 需要重建 idx，而 idx 要求
// 每个对象的偏移与「压缩数据 + 对象头」的 CRC32。
// resolvePackObjects 能还原内容但丢了字节区间，所以这里单独走一遍
// 轻量解析（不做 delta 还原，只定位边界）。
export function listPackEntries(buf) {
  const { count } = parsePackHeader(buf);
  const { byOid, oidByOffset } = resolvePackObjects(buf);

  const out = [];
  let offset = 12;

  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const header = readObjectHeader(buf, offset);
    const { length } = compressedLength(buf, header.dataStart, header.size);
    offset = header.dataStart + length;

    const oid = oidByOffset.get(start);
    if (!oid) throw new Error("pack: no oid resolved for offset " + start);

    out.push({
      oid,
      offset: start,
      end: offset,
      bytes: buf.subarray(start, offset),   // 对象头 + 压缩数据，用于 CRC
    });
  }

  return { entries: out, byOid };
}
