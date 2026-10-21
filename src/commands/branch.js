// branch / checkout：管理引用与 HEAD。

import { readHeadRef, readRef, writeRef, listBranches, setHeadSymref, updateHead, deleteRef } from "../refs.js";
import { flattenTree } from "../tree.js";
import { readCommit } from "../commit.js";
import { readObject } from "../objects.js";
import { writeFile, mkdir, rm, stat } from "node:fs/promises";
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
export async function restoreTree(gitDir, rootDir, commitOid) {
  const commit = await readCommit(gitDir, commitOid);
  const files = await flattenTree(gitDir, commit.tree);
  for (const [rel, entry] of files) {
    const abs = path.join(rootDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const { content } = await readObject(gitDir, entry.oid);
    await writeFile(abs, content);
  }
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
