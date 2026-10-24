// gc：把松散对象打包成 pack，并清理不再需要的松散文件。
//
// 为什么需要它：
//   - 每次 add / commit 都写松散对象，文件数会迅速膨胀（几千个文件时
//     仅目录遍历就很慢）
//   - 只有打成 pack 才能享受 delta 压缩（同一文件的历史版本只存增量）
//
// 安全前提：只有「从引用和索引都不可达」的对象才能删。
// 删错就是永久丢数据，所以这里有完整的两阶段流程：
//   1. 从全部分支 + 索引出发，标记可达对象
//   2. 只把可达对象写进 pack，然后再删松散文件
//
// 不做 gc --prune 的即时删除：不可达对象先保留，
// 因为「刚 add 但还没 commit」的 blob 在索引里是可达的，
// 而 reflog 等机制本项目没有实现，激进清理风险大于收益。

import { readdir, readFile, writeFile, mkdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { readHeadRef, listBranches, readRef } from "../refs.js";
import { readCommit } from "../commit.js";
import { readIndex } from "../index-file.js";
import { readObject, objectPath } from "../objects.js";
import { parseTree } from "../tree.js";
import { buildPack } from "../pack/writer.js";
import { clearPackCache } from "../objects.js";

// 收集所有可达对象（提交、树、blob）。
// 从每个分支的 tip 出发，沿提交图与树结构向下展开。
async function collectReachable(gitDir, onProgress) {
  const reachable = new Map();   // oid -> {type, content}
  const seenCommits = new Set();
  const seenTrees = new Set();

  async function visitBlobOrTree(oid) {
    if (reachable.has(oid)) return;
    let obj;
    try {
      obj = await readObject(gitDir, oid);
    } catch {
      return;   // 对象缺失：仓库可能不完整，跳过而不是崩掉
    }
    reachable.set(oid, obj);
    if (obj.type === "tree") {
      if (seenTrees.has(oid)) return;
      seenTrees.add(oid);
      const entries = parseTree(obj.content);
      for (const e of entries) {
        if (e.type === "tree") await visitBlobOrTree(e.oid);
        else if (e.type === "blob") await visitBlobOrTree(e.oid);
      }
    }
  }

  async function visitCommit(oid) {
    if (seenCommits.has(oid)) return;
    seenCommits.add(oid);

    // 需要原始字节（写 pack 用）和解析结果（找 tree/parent）两样东西。
    // 注意 parseCommit 接受的是 utf8 字符串，直接传 Buffer 会得到
    // "headerBlock.split is not a function"。
    let obj;
    try {
      obj = await readObject(gitDir, oid);
    } catch {
      return;   // 对象缺失或不完整，跳过而不是崩掉
    }
    if (obj.type !== "commit") return;
    reachable.set(oid, obj);

    const { parseCommit } = await import("../commit.js");
    let parsed;
    try {
      parsed = parseCommit(obj.content.toString("utf8"));
    } catch {
      return;
    }

    if (parsed.tree) await visitBlobOrTree(parsed.tree);
    for (const parent of parsed.parents) await visitCommit(parent);
    if (onProgress) onProgress(seenCommits.size);
  }

  // 1) 所有分支
  for (const b of await listBranches(gitDir)) {
    if (b.oid) await visitCommit(b.oid);
  }
  // 2) HEAD（可能是 detached 或指向尚无分支的提交）
  const head = await readHeadRef(gitDir);
  if (head.oid) await visitCommit(head.oid);
  // 3) 索引里的 blob（刚 add 还没 commit 的对象必须保住）
  const index = await readIndex(gitDir);
  for (const e of index.entries) await visitBlobOrTree(e.oid);

  return reachable;
}

// 列出松散对象
async function listLooseObjects(gitDir) {
  const objectsDir = path.join(gitDir, "objects");
  const out = [];
  let dirs;
  try {
    dirs = await readdir(objectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.length !== 2 || !/^[0-9a-f]{2}$/.test(d.name)) continue;
    const sub = path.join(objectsDir, d.name);
    for (const f of await readdir(sub)) {
      if (!/^[0-9a-f]{38}$/.test(f)) continue;
      out.push({ oid: d.name + f, file: path.join(sub, f) });
    }
  }
  return out;
}

export async function gc(gitDir, options = {}) {
  const { dryRun = false, onProgress = null } = options;

  const before = await listLooseObjects(gitDir);
  if (before.length === 0) {
    return { packed: 0, removed: 0, reachable: 0, packSize: 0, looseBefore: 0, dryRun };
  }

  // 只打包「可达」对象，不可达的保持原样（不删除，避免误删）
  const reachable = await collectReachable(gitDir, onProgress);

  // 按类型分组，便于 delta 候选选择（同类型才可能生成 delta）
  const objects = [];
  for (const [, obj] of reachable) objects.push({ type: obj.type, content: obj.content });

  if (objects.length === 0) {
    return { packed: 0, removed: 0, reachable: 0, packSize: 0, looseBefore: before.length, dryRun };
  }

  const built = buildPack(objects, { delta: true });

  if (dryRun) {
    return {
      packed: 0,
      removed: 0,
      reachable: reachable.size,
      packSize: built.pack.length,
      looseBefore: before.length,
      dryRun: true,
      wouldPack: objects.length,
    };
  }

  // 写入 pack
  const packDir = path.join(gitDir, "objects", "pack");
  await mkdir(packDir, { recursive: true });
  const name = "pack-" + built.packChecksum;
  await writeFile(path.join(packDir, name + ".pack"), built.pack);
  await writeFile(path.join(packDir, name + ".idx"), built.idx);

  // pack 写成功后才删松散文件。顺序很重要：
  // 反过来一旦中途失败，对象就永久丢失。
  let removed = 0;
  for (const item of before) {
    if (!reachable.has(item.oid)) continue;   // 不可达的保留
    try {
      await unlink(item.file);
      removed += 1;
    } catch {
      // 已被并发删除，忽略
    }
  }

  // 清理空的两位目录
  const objectsDir = path.join(gitDir, "objects");
  for (const d of await readdir(objectsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.length !== 2) continue;
    const full = path.join(objectsDir, d.name);
    try {
      const left = await readdir(full);
      if (left.length === 0) await rm(full, { recursive: true, force: true });
    } catch {}
  }

  clearPackCache();

  return {
    packed: objects.length,
    removed,
    reachable: reachable.size,
    packSize: built.pack.length,
    packName: name,
    looseBefore: before.length,
    deltaCount: built.entries.filter((e) => e.delta).length,
    dryRun: false,
  };
}

export { collectReachable, listLooseObjects };
