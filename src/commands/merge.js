// merge：把另一个分支合并进当前分支。
//
// 三种情况：
//   1. 快进（fast-forward）：目标分支是当前分支的后代，直接移动指针
//   2. 已经是最新：目标分支已是当前分支的祖先，什么都不做
//   3. 真合并：需要三方归并，可能产生冲突
//
// 冲突时不提交，把冲突内容写进工作区并留标记，与 Git 行为一致。

import { readHeadRef, readRef, writeRef, updateHead } from "../refs.js";
import { readCommit, writeCommit, formatIdentity, localTimezoneOffset } from "../commit.js";
import { flattenTree } from "../tree.js";
import { readObject, writeObject } from "../objects.js";
import { findMergeBase, isAncestor } from "../merge-base.js";
import { merge3, renderMergedFile } from "../merge-file.js";
import { readIndex, writeIndex, entryFromStat } from "../index-file.js";
import { writeTreeFromEntries } from "../tree.js";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

export async function merge(gitDir, rootDir, branchName, {
  author = { name: "tinygit", email: "tinygit@localhost" },
  message = null,
  now = new Date(),
  noCommit = false,
} = {}) {
  const head = await readHeadRef(gitDir);
  if (!head.oid) throw new Error("merge: 当前分支还没有任何提交");

  const targetRef = "refs/heads/" + branchName;
  const targetOid = await readRef(gitDir, targetRef);
  if (!targetOid) throw new Error("merge: 分支不存在: " + branchName);

  const currentBranch = head.ref.replace(/^refs\/heads\//, "");

  // 情况 1：目标已包含在当前分支中
  if (await isAncestor(gitDir, targetOid, head.oid)) {
    return { result: "up-to-date", branch: branchName };
  }

  // 情况 2：快进
  if (await isAncestor(gitDir, head.oid, targetOid)) {
    await updateHead(gitDir, targetOid);
    return { result: "fast-forward", branch: branchName, oid: targetOid };
  }

  // 情况 3：真合并
  const baseOid = await findMergeBase(gitDir, head.oid, targetOid);
  if (!baseOid) throw new Error("merge: 两个分支没有共同历史，无法合并");

  const baseFiles = await filesOfCommit(gitDir, baseOid);
  const oursFiles = await filesOfCommit(gitDir, head.oid);
  const theirsFiles = await filesOfCommit(gitDir, targetOid);

  const allPaths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  const mergedFiles = new Map();   // path -> oid
  const conflicts = [];

  for (const p of allPaths) {
    const baseEntry = baseFiles.get(p);
    const oursEntry = oursFiles.get(p);
    const theirsEntry = theirsFiles.get(p);

    const baseText = baseEntry ? await textOf(gitDir, baseEntry.oid) : null;
    const oursText = oursEntry ? await textOf(gitDir, oursEntry.oid) : null;
    const theirsText = theirsEntry ? await textOf(gitDir, theirsEntry.oid) : null;

    // 二进制文件：不做归并，有分歧就冲突
    if (baseText === null || oursText === null || theirsText === null) {
      const oursSig = oursEntry?.oid ?? null;
      const theirsSig = theirsEntry?.oid ?? null;
      if (oursSig === theirsSig) {
        if (oursSig) mergedFiles.set(p, oursSig);
      } else if (oursSig === (baseEntry?.oid ?? null)) {
        if (theirsSig) mergedFiles.set(p, theirsSig);
      } else if (theirsSig === (baseEntry?.oid ?? null)) {
        if (oursSig) mergedFiles.set(p, oursSig);
      } else {
        conflicts.push({ path: p, binary: true });
      }
      continue;
    }

    // 一边没变 → 直接采用另一边（这是最常见的快路径）
    if (oursText === baseText) {
      if (theirsEntry) {
        mergedFiles.set(p, theirsEntry.oid);
        await writeWorktreeFile(rootDir, p, theirsText);
      } else {
        await removeWorktreeFile(rootDir, p);
      }
      continue;
    }
    if (theirsText === baseText) {
      if (oursEntry) {
        mergedFiles.set(p, oursEntry.oid);
      }
      continue;
    }

    // 两边都改了 → 三路归并
    const base = splitLines(baseText);
    const ours = splitLines(oursText);
    const theirs = splitLines(theirsText);
    const { merged, conflicts: fileConflicts } = merge3(base, ours, theirs);

    if (fileConflicts.length === 0) {
      const content = merged.length ? merged.join("\n") + "\n" : "";
      const oid = await writeObject(gitDir, "blob", Buffer.from(content, "utf8"));
      mergedFiles.set(p, oid);
      await writeWorktreeFile(rootDir, p, content);
    } else {
      // 冲突：按 Git 标记格式生成完整文件，保留在 working tree 供人工解决
      const rendered = renderMergedFile(base, ours, theirs, {
        oursLabel: currentBranch,
        theirsLabel: branchName,
      });
      await writeWorktreeFile(rootDir, p, rendered.lines.join("\n") + "\n");
      conflicts.push({ path: p, regions: fileConflicts.length });
    }
  }

  if (conflicts.length > 0) {
    return { result: "conflict", branch: branchName, conflicts, baseOid };
  }

  // 重建索引与 tree
  const entries = [];
  for (const [p, oid] of mergedFiles) {
    const abs = path.join(rootDir, p);
    const st = await stat(abs);
    entries.push(entryFromStat(p, oid, "100644", st));
  }
  const index = { version: 2, entries };
  await writeIndex(gitDir, index);

  if (noCommit) {
    return { result: "merged-not-committed", branch: branchName, baseOid };
  }

  const treeOid = await writeTreeFromEntries(
    gitDir,
    entries.map((e) => ({ path: e.path, oid: e.oid, mode: e.mode }))
  );

  const seconds = Math.floor(now.getTime() / 1000);
  const identity = formatIdentity(author.name, author.email, seconds, localTimezoneOffset(now));
  const commitMessage = message
    ? message
    : "Merge branch '" + branchName + "' into " + currentBranch + "\n";

  const newOid = await writeCommit(gitDir, {
    tree: treeOid,
    parents: [head.oid, targetOid],
    author: identity,
    committer: identity,
    message: commitMessage.trimEnd() + "\n",
  });

  await writeRef(gitDir, head.ref, newOid);
  return { result: "merged", branch: branchName, oid: newOid, baseOid, treeOid };
}

async function filesOfCommit(gitDir, commitOid) {
  const commit = await readCommit(gitDir, commitOid);
  return flattenTree(gitDir, commit.tree);
}

async function textOf(gitDir, oid) {
  const { content } = await readObject(gitDir, oid);
  if (content.includes(0)) return null;   // 二进制
  return content.toString("utf8");
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function writeWorktreeFile(rootDir, rel, content) {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function removeWorktreeFile(rootDir, rel) {
  const { unlink } = await import("node:fs/promises");
  try { await unlink(path.join(rootDir, rel)); } catch { }
}
