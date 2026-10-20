// HEAD 与分支引用。
//
// HEAD 通常是符号引用："ref: refs/heads/main"，指向某个分支文件。
// 也允许分离头指针（detached HEAD）：HEAD 直接存一个 40 位 sha。
//
// 读取时要递归解析符号引用，否则会出现「HEAD 指向 HEAD」的循环；
// 这里加了深度上限来防环。

import { readFile, writeFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";

const MAX_SYMREF_DEPTH = 10;

export async function readHeadRef(gitDir) {
  let ref = "HEAD";
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth += 1) {
    let text;
    try {
      text = await readFile(path.join(gitDir, ref), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return { ref, oid: null };
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

export async function readRef(gitDir, ref) {
  try {
    const text = await readFile(path.join(gitDir, ref), "utf8");
    const trimmed = text.trim();
    if (trimmed.startsWith("ref: ")) {
      return readRef(gitDir, trimmed.slice(5).trim());
    }
    return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeRef(gitDir, ref, oid) {
  const file = path.join(gitDir, ref);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, oid + "\n");
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

export async function listBranches(gitDir) {
  const dir = path.join(gitDir, "refs", "heads");
  const out = [];
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
      else out.push(rel);
    }
  }
  await walk(dir, "");
  return out.sort();
}

export async function deleteRef(gitDir, ref) {
  try { await unlink(path.join(gitDir, ref)); } catch (err) { if (err.code !== "ENOENT") throw err; }
}

export async function setHeadSymref(gitDir, ref) {
  await writeFile(path.join(gitDir, "HEAD"), "ref: " + ref + "\n");
}
