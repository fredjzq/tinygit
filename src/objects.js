// Git 对象模型：blob / tree / commit 的序列化与内容寻址存储。
//
// Git 的本质是一个「内容寻址文件系统」：
// 对象的文件名 = 内容哈希，所以同样内容永远得到同样名字，天然去重。
// 对象在磁盘上是 zlib 压缩的 "<type> <size>\0<content>"。

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

// 计算对象 id。注意哈希覆盖的是「头部+内容」，不只是内容，
// 所以空 blob 和空 tree 的哈希不同。
export function hashObject(type, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const header = Buffer.from(type + " " + body.length + "\0", "latin1");
  return createHash("sha1").update(header).update(body).digest("hex");
}

export function encodeObject(type, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const header = Buffer.from(type + " " + body.length + "\0", "latin1");
  const oid = createHash("sha1").update(header).update(body).digest("hex");
  return { oid, raw: deflateSync(Buffer.concat([header, body])) };
}

export function decodeObject(raw) {
  const buf = inflateSync(raw);
  const nul = buf.indexOf(0);
  if (nul < 0) throw new Error("corrupt object: missing header terminator");
  const header = buf.subarray(0, nul).toString("latin1");
  const space = header.indexOf(" ");
  const type = header.slice(0, space);
  const size = Number(header.slice(space + 1));
  const body = buf.subarray(nul + 1);
  if (body.length !== size) throw new Error("corrupt object: size mismatch");
  return { type, content: body };
}

export function objectPath(gitDir, oid) {
  return path.join(gitDir, "objects", oid.slice(0, 2), oid.slice(2));
}

export async function objectExists(gitDir, oid) {
  try {
    await access(objectPath(gitDir, oid));
    return true;
  } catch {
    return false;
  }
}

export async function writeObject(gitDir, type, content) {
  const { oid, raw } = encodeObject(type, content);
  const file = objectPath(gitDir, oid);
  if (!(await objectExists(gitDir, oid))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw);
  }
  return oid;
}

export async function readObject(gitDir, oid) {
  let raw;
  try {
    raw = await readFile(objectPath(gitDir, oid));
  } catch (err) {
    if (err.code === "ENOENT") {
      // 只支持松散对象。packfile 需要解析 idx + delta，本实现未包含。
      throw new Error("object not found: " + oid + " (packed objects are not supported)");
    }
    throw err;
  }
  return decodeObject(raw);
}

export async function readObjectText(gitDir, oid) {
  const obj = await readObject(gitDir, oid);
  return { type: obj.type, text: obj.content.toString("utf8") };
}
