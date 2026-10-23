// Git 对象模型：blob / tree / commit 的序列化与内容寻址存储。
//
// Git 的本质是一个「内容寻址文件系统」：
// 对象的文件名 = 内容哈希，所以同样内容永远得到同样名字，天然去重。
// 对象在磁盘上是 zlib 压缩的 "<type> <size>\0<content>"。

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { readFile, writeFile, mkdir, access, readdir, stat } from "node:fs/promises";
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
    // 松散对象不存在时，可能在 pack 里
  }
  try {
    const repo = await getPackRepo(gitDir);
    return await repo.has(oid);
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

// 每个仓库的 pack 读取器只创建一次：解析 pack 需要解压全部对象，
// 开销远大于读一个松散文件，重复创建会让命令慢到不可用。
//
// 但不能无限期缓存：pack 文件可能在进程运行期间变化
// （fetch 新增 pack、gc 重打包、测试里删改 objects 目录）。
// 所以按「pack 文件名 + 大小 + mtime」算一个签名，签名变化就重建。
const packRepoCache = new Map();

async function packSignature(gitDir) {
  const packDir = path.join(gitDir, "objects", "pack");
  let entries;
  try {
    entries = await readdir(packDir);
  } catch {
    return "no-pack-dir";
  }
  const parts = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".pack") && !name.endsWith(".idx")) continue;
    try {
      const st = await stat(path.join(packDir, name));
      parts.push(name + ":" + st.size + ":" + Math.floor(st.mtimeMs));
    } catch {
      parts.push(name + ":missing");
    }
  }
  return parts.join("|");
}

async function getPackRepo(gitDir) {
  const key = path.resolve(gitDir);
  const sig = await packSignature(gitDir);
  const cached = packRepoCache.get(key);
  if (cached && cached.sig === sig) return cached.repo;

  const { createPackRepository } = await import("./pack/index.js");
  const repo = createPackRepository(gitDir);
  packRepoCache.set(key, { sig, repo });
  return repo;
}

// 测试辅助：清空 pack 缓存
export function clearPackCache() {
  packRepoCache.clear();
}

export async function readObject(gitDir, oid) {
  // 先查松散对象：真 Git 里松散对象优先于 pack，
  // 且未打包的仓库不必付出解析 pack 的代价。
  try {
    const raw = await readFile(objectPath(gitDir, oid));
    return decodeObject(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  // 回退到 pack。clone 下来的仓库对象几乎全在 pack 里。
  let packed = null;
  try {
    const repo = await getPackRepo(gitDir);
    packed = await repo.get(oid);
  } catch (err) {
    throw new Error("object not found: " + oid + " (pack read failed: " + err.message + ")");
  }
  if (!packed) {
    throw new Error("object not found: " + oid + " (neither loose nor in any pack)");
  }
  return { type: packed.type, content: packed.content };
}

// 列出仓库里所有对象（松散 + pack），用于诊断与完整性检查。
export async function listAllObjects(gitDir) {
  const out = new Set();

  async function walk(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { await walk(path.join(dir, e.name), e.name); continue; }
      if (prefix.length === 2) out.add(prefix + e.name);
    }
  }
  await walk(path.join(gitDir, "objects"), "");

  try {
    const repo = await getPackRepo(gitDir);
    for (const oid of await repo.list()) out.add(oid);
  } catch {
    // 没有 pack 目录属正常情况
  }
  return [...out];
}

export async function readObjectText(gitDir, oid) {
  const obj = await readObject(gitDir, oid);
  return { type: obj.type, text: obj.content.toString("utf8") };
}
