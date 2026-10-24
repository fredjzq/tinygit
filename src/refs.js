// HEAD 与分支引用。
//
// HEAD 通常是符号引用："ref: refs/heads/main"，指向某个分支文件。
// 也允许分离头指针（detached HEAD）：HEAD 直接存一个 40 位 sha。
//
// 引用有两个存储位置：
//   1. 松散 ref：.git/refs/heads/<name> 一个文件一个分支
//   2. packed-refs：所有分支合并成一个文本文件
//
// **松散 ref 优先**。更新已打包的分支会写松散文件，它覆盖打包记录。
// 这是真 git 的语义，也解释了为什么「只删松散文件」时分支会复活——
// packed-refs 里的记录还在。
//
// 读取时要递归解析符号引用，否则会出现「HEAD 指向 HEAD」的循环；
// 这里加了深度上限来防环。

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { readPackedRefs, removePackedRef, setPackedRef } from "./packed-refs.js";

const MAX_SYMREF_DEPTH = 10;

export async function readHeadRef(gitDir) {
  let ref = "HEAD";
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth += 1) {
    let text;
    try {
      text = await readFile(path.join(gitDir, ref), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        // 松散文件不存在，可能被 pack 了
        return { ref, oid: await readPackedRef(gitDir, ref) };
      }
      throw err;
    }
    const trimmed = text.trim();
    if (trimmed.startsWith("ref: ")) {
      ref = trimmed.slice(5).trim();
      continue;
    }
    return { ref, oid: /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null };
  }
  throw new Error("HEAD: symbolic ref chain too deep (possible loop)");
}

// 从 packed-refs 里查单个引用
async function readPackedRef(gitDir, ref) {
  const map = await readPackedRefs(gitDir);
  return map.get(ref) ?? null;
}

export async function readRef(gitDir, ref) {
  try {
    const text = await readFile(path.join(gitDir, ref), "utf8");
    const trimmed = text.trim();
    if (trimmed.startsWith("ref: ")) {
      return readRef(gitDir, trimmed.slice(5).trim());
    }
    return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
  } catch (err) {
    if (err.code === "ENOENT") {
      // 松散不存在 → 退回 packed-refs
      return readPackedRef(gitDir, ref);
    }
    throw err;
  }
}

export async function writeRef(gitDir, ref, oid) {
  const file = path.join(gitDir, ref);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, oid + "\n");
  // 松散 ref 会覆盖 packed-refs 里的旧值，无需同步更新 packed-refs
}

export async function updateHead(gitDir, oid) {
  const { ref } = await readHeadRef(gitDir);
  if (ref === "HEAD") {
    // 分离头指针
    await writeFile(path.join(gitDir, "HEAD"), oid + "\n");
    return "HEAD";
  }
  await writeRef(gitDir, ref, oid);
  return ref;
}

// 列出所有分支短名。松散目录 + packed-refs 合并去重。
export async function listBranches(gitDir) {
  const dir = path.join(gitDir, "refs", "heads");
  const names = new Set();

  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(current, e.name), rel);
      else names.add(rel);
    }
  }
  await walk(dir, "");

  // 合并 packed-refs 里的分支（只取 refs/heads/ 前缀）
  const packed = await readPackedRefs(gitDir);
  for (const ref of packed.keys()) {
    if (ref.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
  }

  return [...names].sort();
}

// 删除分支引用。两处都要删，否则 packed-refs 里的记录会让它复活。
export async function deleteRef(gitDir, ref) {
  try {
    await unlink(path.join(gitDir, ref));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await removePackedRef(gitDir, ref);
}

export async function setHeadSymref(gitDir, ref) {
  await writeFile(path.join(gitDir, "HEAD"), "ref: " + ref + "\n");
}

// 把现有分支全部写入 packed-refs（gc --pack-refs 用）
export async function repackRefs(gitDir) {
  const branches = await listBranches(gitDir);
  let count = 0;
  for (const name of branches) {
    const ref = "refs/heads/" + name;
    const oid = await readRef(gitDir, ref);
    if (oid) {
      await setPackedRef(gitDir, ref, oid);
      count += 1;
      // 删掉松散文件：真 git 的 pack-refs 也会这么做
      try {
        await unlink(path.join(gitDir, ref));
      } catch {}
    }
  }
  return count;
}

export { readPackedRef };
