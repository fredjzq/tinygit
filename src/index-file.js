// Git 索引（暂存区）：二进制格式，签名 "DIRC"。
//
// 每条目 62 字节固定头 + 路径 + 填充，整体补齐到 8 字节倍数。
// 文件末尾是前文全部内容的 SHA-1 校验和。
// 这也是唯一需要精确掌控字节布局的地方——写错一位真 Git 就拒绝读取。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const HEADER_SIZE = 12;
const ENTRY_FIXED = 62;

export function emptyIndex() {
  return { version: 2, entries: [] };
}

function entryLength(nameLength) {
  return (ENTRY_FIXED + nameLength + 8) & ~7;
}

export function parseIndex(buf) {
  if (buf.length < HEADER_SIZE + 20) return emptyIndex();
  if (buf.subarray(0, 4).toString("latin1") !== "DIRC") {
    throw new Error("index: bad signature (not a git index)");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error("index: unsupported version " + version);
  }
  const count = buf.readUInt32BE(8);
  const entries = [];
  let off = HEADER_SIZE;
  for (let i = 0; i < count; i += 1) {
    const flags = buf.readUInt16BE(off + 60);
    const nameLen = flags & 0x0fff;
    const nameBytes = buf.subarray(off + ENTRY_FIXED, off + ENTRY_FIXED + nameLen);
    entries.push({
      path: nameBytes.toString("utf8"),
      oid: buf.subarray(off + 40, off + 60).toString("hex"),
      mode: buf.readUInt32BE(off + 24),
      stage: (flags >>> 12) & 0x3,
      stat: {
        ctime: buf.readUInt32BE(off),
        ctimeNano: buf.readUInt32BE(off + 4),
        mtime: buf.readUInt32BE(off + 8),
        mtimeNano: buf.readUInt32BE(off + 12),
        dev: buf.readUInt32BE(off + 16),
        ino: buf.readUInt32BE(off + 20),
        uid: buf.readUInt32BE(off + 28),
        gid: buf.readUInt32BE(off + 32),
        size: buf.readUInt32BE(off + 36),
      },
    });
    off += entryLength(nameLen);
  }
  return { version, entries };
}

export function entryFromStat(filePath, oid, mode, stat) {
  return {
    path: filePath,
    oid,
    mode: typeof mode === "number" ? mode : parseInt(mode, 8),
    stage: 0,
    stat: {
      ctime: Math.floor(stat.ctimeMs / 1000) >>> 0,
      ctimeNano: 0,
      mtime: Math.floor(stat.mtimeMs / 1000) >>> 0,
      mtimeNano: Math.floor((stat.mtimeMs % 1000) * 1e6) >>> 0,
      dev: Number(stat.dev) >>> 0,
      ino: Number(stat.ino) >>> 0,
      uid: Number(stat.uid ?? 0) >>> 0,
      gid: Number(stat.gid ?? 0) >>> 0,
      size: Number(stat.size) >>> 0,
    },
  };
}

export function serializeIndex(index) {
  const sorted = [...index.entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"))
  );
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(index.version ?? 2, 4);
  header.writeUInt32BE(sorted.length, 8);

  const parts = [header];
  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const buf = Buffer.alloc(entryLength(nameBytes.length));
    buf.writeUInt32BE(entry.stat.ctime >>> 0, 0);
    buf.writeUInt32BE(entry.stat.ctimeNano >>> 0, 4);
    buf.writeUInt32BE(entry.stat.mtime >>> 0, 8);
    buf.writeUInt32BE(entry.stat.mtimeNano >>> 0, 12);
    buf.writeUInt32BE(entry.stat.dev >>> 0, 16);
    buf.writeUInt32BE(entry.stat.ino >>> 0, 20);
    buf.writeUInt32BE(entry.mode >>> 0, 24);
    buf.writeUInt32BE(entry.stat.uid >>> 0, 28);
    buf.writeUInt32BE(entry.stat.gid >>> 0, 32);
    buf.writeUInt32BE(entry.stat.size >>> 0, 36);
    Buffer.from(entry.oid, "hex").copy(buf, 40);
    const flags = (Math.min(nameBytes.length, 0x0fff) | (((entry.stage ?? 0) & 3) << 12)) & 0xffff;
    buf.writeUInt16BE(flags, 60);
    nameBytes.copy(buf, ENTRY_FIXED);
    parts.push(buf);
  }
  const body = Buffer.concat(parts);
  const checksum = createHash("sha1").update(body).digest();
  return Buffer.concat([body, checksum]);
}

export async function readIndex(gitDir) {
  try {
    const buf = await readFile(path.join(gitDir, "index"));
    return parseIndex(buf);
  } catch (err) {
    if (err.code === "ENOENT") return emptyIndex();
    throw err;
  }
}

export async function writeIndex(gitDir, index) {
  await writeFile(path.join(gitDir, "index"), serializeIndex(index));
}
