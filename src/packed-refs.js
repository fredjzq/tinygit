// packed-refs：把分支引用打包成一个文件。
//
// 为什么需要：每个分支是一个独立文件时，1000 个分支就是 1000 个文件，
// 任何「列出所有分支」的操作都要遍历整个目录。真 git 用 packed-refs
// 把它们合并成一个文本文件，格式很简单：
//
//   # pack-refs with: peeled fully-peeled sorted
//   <40 位 sha> <完整引用名>
//
// 规则（与真 git 一致）：
//   - 松散 ref 优先于 packed-refs。更新一个已打包的分支时会写松散文件，
//     松散文件覆盖打包记录。
//   - 删除已打包的分支必须重写 packed-refs，否则它会「复活」。
//   - 注释行以 # 开头，忽略。
//
// 这是最容易出错的地方：如果只删松散文件不处理 packed-refs，
// 被删的分支下次读还会出现，用户会觉得「删不掉」。

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

const HEADER = "# pack-refs with: peeled fully-peeled sorted\n";

function packedRefsPath(gitDir) {
  return path.join(gitDir, "packed-refs");
}

// 读取 packed-refs，返回 Map<refName, oid>
export async function readPackedRefs(gitDir) {
  let text;
  try {
    text = await readFile(packedRefsPath(gitDir), "utf8");
  } catch {
    return new Map();
  }

  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // peeled 行以 ^ 开头，记录的是 tag 指向的对象（本项目不强依赖）
    if (line.startsWith("^")) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const oid = line.slice(0, sp);
    const ref = line.slice(sp + 1);
    if (!/^[0-9a-f]{40}$/.test(oid)) continue;
    out.set(ref, oid);
  }
  return out;
}

// 原子写入：先写临时文件再 rename。
// 直接覆写有风险——中途失败会留下半个文件，所有分支引用就丢了。
async function writePackedRefs(gitDir, map) {
  const entries = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lines = [HEADER];
  for (const [ref, oid] of entries) lines.push(oid + " " + ref + "\n");

  const target = packedRefsPath(gitDir);
  const tmp = target + ".tmp";
  await mkdir(gitDir, { recursive: true });
  await writeFile(tmp, lines.join(""), "utf8");
  await rename(tmp, target);
}

export async function packRefs(gitDir, refs, options = {}) {
  // refs: Map<refName, oid> 或 [{ref, oid}]
  const map = refs instanceof Map ? new Map(refs) : new Map(refs.map((r) => [r.ref, r.oid]));
  await writePackedRefs(gitDir, map);
  return map.size;
}

// 更新/新增一条打包引用
export async function setPackedRef(gitDir, ref, oid) {
  const map = await readPackedRefs(gitDir);
  map.set(ref, oid);
  await writePackedRefs(gitDir, map);
}

// 从 packed-refs 移除一条。
// 关键：删除分支时必须调用它，否则分支会从 packed-refs「复活」。
export async function removePackedRef(gitDir, ref) {
  const map = await readPackedRefs(gitDir);
  if (!map.has(ref)) return false;
  map.delete(ref);
  if (map.size === 0) {
    // 空文件没有意义，直接删掉
    try {
      await unlink(packedRefsPath(gitDir));
    } catch {}
  } else {
    await writePackedRefs(gitDir, map);
  }
  return true;
}

// 把散落的 refs/heads 目录合并进 packed-refs
export async function packAllRefs(gitDir, branches) {
  const map = new Map();
  for (const b of branches) {
    if (b.oid) map.set(b.ref, b.oid);
  }
  await writePackedRefs(gitDir, map);
  return map.size;
}

export { packedRefsPath };
