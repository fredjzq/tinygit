// branch / checkout：管理引用与 HEAD。

import { readHeadRef, readRef, writeRef, listBranches, setHeadSymref, updateHead, deleteRef } from "../refs.js";
import { flattenTree } from "../tree.js";
import { readCommit } from "../commit.js";
import { readObject } from "../objects.js";
import { writeFile, mkdir, rm, stat, readdir } from "node:fs/promises";
import path from "node:path";

export async function branchList(gitDir) {
  const head = await readHeadRef(gitDir);
  const current = head.ref.replace(/^refs\/heads\//, "");
  const branches = await listBranches(gitDir);
  return branches.map((name) => ({
    name,
    current: name === current,
    oid: null,
  }));
}

export async function createBranch(gitDir, name, startPoint = null) {
  const target = "refs/heads/" + name;
  if (await readRef(gitDir, target)) throw new Error("branch already exists: " + name);
  const oid = startPoint ?? (await readHeadRef(gitDir)).oid;
  if (!oid) throw new Error("branch: no commit to point at");
  await writeRef(gitDir, target, oid);
  return oid;
}

export async function switchBranch(gitDir, rootDir, name) {
  const target = "refs/heads/" + name;
  const oid = await readRef(gitDir, target);
  if (!oid) {
    // 允许创建 unborn 分支（还没有任何提交时直接切过去）
    const head = await readHeadRef(gitDir);
    if (head.oid === null) {
      await setHeadSymref(gitDir, target);
      return { created: true, oid: null };
    }
    throw new Error("branch not found: " + name);
  }
  await restoreTree(gitDir, rootDir, oid);
  await setHeadSymref(gitDir, target);
  return { created: false, oid };
}

// 把某个提交的 tree 检出到工作区（不实现三方合并，纯覆盖）
// 把某个提交的 tree 检出到工作区。
//
// **必须同时删除目标树中不存在的旧文件**，这是 checkout 的语义。
// 只写不删会造成跨分支污染：切到 feature 写了 f1.txt，切回 main 后
// f1.txt 仍留在磁盘上，此时 `add .` 会把它提交进 main —— 两个分支的
// 内容混在一起，且看不出是哪一步出的错。
//
// 删除范围要谨慎：只删「上一个 checkout 时写过、且属于被跟踪集合」的文件，
// 不能扫描整个目录删除未知文件，否则会误删用户未跟踪的私人文件。
// 这里的做法是：以「索引里记录的路径」为准计算差集。
export async function restoreTree(gitDir, rootDir, commitOid) {
  const commit = await readCommit(gitDir, commitOid);
  const files = await flattenTree(gitDir, commit.tree);

  // 目标树里的全部路径（用于判断哪些旧文件要删）
  const targetPaths = new Set(files.keys());

  // 当前被跟踪的路径：来自索引。索引是「哪些文件属于版本控制」的唯一真相，
  // 用它算差集不会误伤未跟踪文件。
  let trackedPaths = new Set();
  try {
    const { readIndex } = await import("../index-file.js");
    const idx = await readIndex(gitDir);
    trackedPaths = new Set(idx.entries.map((e) => e.path));
  } catch {
    // 索引不存在时退化为「只写不删」，至少不破坏现有内容
  }

  // 1) 先删掉「当前跟踪但目标树没有」的文件
  for (const rel of trackedPaths) {
    if (targetPaths.has(rel)) continue;
    try {
      await rm(path.join(rootDir, rel), { force: true });
    } catch {}
  }

  // 2) 再写入目标树的文件
  const { writeIndex, entryFromStat } = await import("../index-file.js");
  const entries = [];
  for (const [rel, entry] of files) {
    const abs = path.join(rootDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const { content } = await readObject(gitDir, entry.oid);
    await writeFile(abs, content);

    // 检出后同步索引，否则 status 会把所有文件误报为已删除
    let st;
    try { st = await stat(abs); } catch { st = null; }
    const mode = typeof entry.mode === "number" ? entry.mode : parseInt(entry.mode, 8);
    if (st) {
      entries.push(entryFromStat(rel, entry.oid, mode, st));
    } else {
      entries.push({
        path: rel, oid: entry.oid, mode, stage: 0,
        stat: { ctime: 0, ctimeNano: 0, mtime: 0, mtimeNano: 0, dev: 0, ino: 0, uid: 0, gid: 0, size: content.length },
      });
    }
  }

  // 清理因删除文件而变空的目录（不删非空目录）
  for (const rel of trackedPaths) {
    if (targetPaths.has(rel)) continue;
    const dir = path.dirname(path.join(rootDir, rel));
    try {
      const left = await readdir(dir);
      if (left.length === 0) await rm(dir, { recursive: true, force: true });
    } catch {}
  }

  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  await writeIndex(gitDir, { version: 2, entries });

  return files.size;
}

export async function deleteBranch(gitDir, name, { force = false } = {}) {
  const head = await readHeadRef(gitDir);
  if (head.ref === "refs/heads/" + name) throw new Error("cannot delete the current branch: " + name);
  const oid = await readRef(gitDir, "refs/heads/" + name);
  if (!oid) throw new Error("branch not found: " + name);
  void force;
  await deleteRef(gitDir, "refs/heads/" + name);
  return oid;
}
